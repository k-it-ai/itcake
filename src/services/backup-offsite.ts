import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { env } from '$env/dynamic/private';
import { db, getSetting, setSetting, parseSqliteUtc } from '$lib/server/db.js';
import { isEncryptedBackup } from '$lib/server/backup-crypto.js';
import { encryptField, decryptField, isEncryptedField } from '$lib/server/field-crypto.js';
import { BACKUP_DIR } from '$lib/server/data-dir.js';
import { resolveTarget } from '$lib/server/checks/validate-target.js';
import { createBackup, withBackupLock, BackupInProgressError } from '$services/backups.js';
import type { BackupSettings } from '$lib/types.js';

// Returns the validated IP so callers can pin DNS via a custom Agent
// lookup, closing the rebinding TOCTOU window.
async function validateOffsiteUrl(url: string, label: string): Promise<{ pinnedIp: string; isHttps: boolean }> {
	if (!/^https?:\/\//i.test(url)) throw new Error(`${label} URL must be http(s)`);
	const isHttps = url.toLowerCase().startsWith('https://');
	if (!isHttps && env.NODE_ENV === 'production') {
		throw new Error(`${label} requires https:// in production (would leak credentials in clear)`);
	}
	const parsed = new URL(url);
	const pinnedIp = await resolveTarget(parsed.hostname);
	return { pinnedIp, isHttps };
}

function pinningAgent(pinnedIp: string, isHttps: boolean): http.Agent | https.Agent {
	const family = pinnedIp.includes(':') ? 6 : 4;
	const lookup = (_hostname: string, optionsOrCb: unknown, maybeCb?: unknown) => {
		const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as (...args: unknown[]) => void;
		const opts = typeof optionsOrCb === 'object' && optionsOrCb !== null ? optionsOrCb as Record<string, unknown> : {};
		if (opts.all) cb(null, [{ address: pinnedIp, family }]);
		else cb(null, pinnedIp, family);
	};
	return isHttps
		? new https.Agent({ lookup, minVersion: 'TLSv1.2' })
		: new http.Agent({ lookup });
}

// Throws WITHOUT the response body — leaking probed-service banners
// back to the operator would turn the test endpoint into an SSRF oracle.
async function pinnedRequest(
	method: 'PUT',
	fullUrl: string,
	pinnedIp: string,
	isHttps: boolean,
	headers: Record<string, string>,
	body: Buffer,
	timeoutMs: number
): Promise<number> {
	const agent = pinningAgent(pinnedIp, isHttps);
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const status = await new Promise<number>((resolve, reject) => {
			const mod = isHttps ? https : http;
			const req = mod.request(fullUrl, {
				method,
				agent,
				signal: controller.signal,
				headers
			}, (res) => {
				let drained = 0;
				res.on('data', (c: Buffer) => {
					drained += c.length;
					if (drained > 64 * 1024) req.destroy(new Error('response body too large'));
				});
				res.on('end', () => resolve(res.statusCode ?? 0));
				res.on('error', reject);
			});
			req.on('error', reject);
			req.end(new Uint8Array(body));
		});
		clearTimeout(timer);
		return status;
	} finally {
		agent.destroy();
	}
}

interface UploadResult {
	ok: boolean;
	error?: string;
	sizeBytes?: number;
	remoteKey?: string;
}

// AWS SigV4 over our pinning HTTP agent — manual implementation so we
// don't pull aws-sdk for one PUT path.
function sha256Hex(buf: Buffer | string): string {
	return crypto.createHash('sha256').update(buf).digest('hex');
}

function hmac(key: Buffer | string, msg: string): Buffer {
	return crypto.createHmac('sha256', key).update(msg).digest();
}

function sigV4SigningKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
	const kDate = hmac('AWS4' + secretKey, dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, service);
	return hmac(kService, 'aws4_request');
}

interface S3PutOpts {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	key: string;
	body: Buffer;
	contentType?: string;
}

async function s3Put(opts: S3PutOpts): Promise<void> {
	const { pinnedIp, isHttps } = await validateOffsiteUrl(opts.endpoint, 'S3 endpoint');
	const url = new URL(opts.endpoint);
	// Path-style addressing works for every provider; per-segment encoding
	// keeps the canonical URI in sync with what fetch builds.
	const host = url.host;
	const encodedKey = opts.key.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
	const encodedBucket = encodeURIComponent(opts.bucket);
	const objectPath = `/${encodedBucket}/${encodedKey}`;
	const fullUrl = `${url.protocol}//${host}${objectPath}`;

	const now = new Date();
	const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
	const dateStamp = amzDate.slice(0, 8);
	const service = 's3';
	const algorithm = 'AWS4-HMAC-SHA256';
	const credentialScope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
	const payloadHash = sha256Hex(opts.body);

	const headers: Record<string, string> = {
		'host': host,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': amzDate,
		'content-type': opts.contentType || 'application/octet-stream'
	};

	const signedHeaderKeys = Object.keys(headers).map(h => h.toLowerCase()).sort();
	const canonicalHeaders = signedHeaderKeys.map(h => `${h}:${headers[h]}\n`).join('');
	const signedHeaders = signedHeaderKeys.join(';');

	const canonicalRequest = [
		'PUT',
		objectPath,
		'',
		canonicalHeaders,
		signedHeaders,
		payloadHash
	].join('\n');

	const stringToSign = [algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey = sigV4SigningKey(opts.secretAccessKey, dateStamp, opts.region, service);
	const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

	const auth = `${algorithm} Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const status = await pinnedRequest('PUT', fullUrl, pinnedIp, isHttps, { ...headers, authorization: auth }, opts.body, 120_000);
	if (status < 200 || status >= 300) {
		throw new Error(`S3 PUT failed (status ${status})`);
	}
}

interface WebdavPutOpts {
	url: string;
	username: string;
	password: string;
	key: string;
	body: Buffer;
}

async function webdavPut(opts: WebdavPutOpts): Promise<void> {
	const { pinnedIp, isHttps } = await validateOffsiteUrl(opts.url, 'WebDAV');
	const base = opts.url.endsWith('/') ? opts.url : opts.url + '/';
	const encodedKey = opts.key.split('/').map(encodeURIComponent).join('/');
	const target = base + encodedKey;
	const auth = 'Basic ' + Buffer.from(`${opts.username}:${opts.password}`).toString('base64');

	const status = await pinnedRequest('PUT', target, pinnedIp, isHttps, {
		'Authorization': auth,
		'Content-Type': 'application/octet-stream'
	}, opts.body, 120_000);
	if (status !== 200 && status !== 201 && status !== 204) {
		throw new Error(`WebDAV PUT failed (status ${status})`);
	}
}

function passthroughOrDecrypt(value: string): string {
	return isEncryptedField(value) ? decryptField(value) : value;
}

export async function runOffsiteBackup(): Promise<UploadResult> {
	const settings = getSetting<BackupSettings>('backup');
	if (!settings || !settings.offsite?.enabled) {
		return { ok: false, error: 'off-site backup not enabled' };
	}

	let result: UploadResult = { ok: false };
	try {
		// Shared backup mutex with manual "Backup now" — _tmp_<timestamp>.db
		// collides at second precision. Lock released after createBackup;
		// upload runs outside it so a long transfer doesn't block another
		// backup attempt.
		const info = await withBackupLock(() => createBackup());
		const localPath = path.join(BACKUP_DIR, info.filename);
		if (!existsSync(localPath)) throw new Error('backup file vanished after createBackup');
		const body: Buffer = Buffer.from(readFileSync(localPath));
		// createBackup() is the single encryption boundary — wrapping again
		// here would emit `.zip.enc.enc` that no longer round-trips.
		const remoteName = info.filename;
		// Refuse to upload plaintext to a remote when a passphrase is
		// configured (inconsistency in createBackup()).
		const passphraseConfigured = !!passthroughOrDecrypt(settings.encryptionPassphrase || '');
		if (passphraseConfigured && !isEncryptedBackup(body)) {
			throw new Error('backup passphrase is configured but the local backup is not encrypted');
		}

		const target = settings.offsite.target;
		if (target === 's3') {
			const s3 = settings.offsite.s3;
			const secret = passthroughOrDecrypt(s3.secretAccessKey);
			if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !secret) {
				throw new Error('S3 settings incomplete');
			}
			const key = (s3.pathPrefix || '') + remoteName;
			await s3Put({
				endpoint: s3.endpoint, region: s3.region || 'us-east-1', bucket: s3.bucket,
				accessKeyId: s3.accessKeyId, secretAccessKey: secret, key, body
			});
			result = { ok: true, sizeBytes: body.length, remoteKey: key };
		} else if (target === 'webdav') {
			const wd = settings.offsite.webdav;
			const pass = passthroughOrDecrypt(wd.password);
			if (!wd.url || !wd.username || !pass) {
				throw new Error('WebDAV settings incomplete');
			}
			await webdavPut({ url: wd.url, username: wd.username, password: pass, key: remoteName, body });
			result = { ok: true, sizeBytes: body.length, remoteKey: remoteName };
		} else {
			throw new Error(`unknown off-site target: ${target}`);
		}
	} catch (e) {
		if (e instanceof BackupInProgressError) {
			return { ok: false, error: e.message };
		}
		result = { ok: false, error: e instanceof Error ? e.message : String(e) };
	}

	try {
		const cur = getSetting<BackupSettings>('backup');
		if (cur && cur.offsite) {
			cur.offsite.lastUpload = {
				at: new Date().toISOString(),
				ok: result.ok,
				error: result.error,
				sizeBytes: result.sizeBytes
			};
			setSetting('backup', cur);
		}
	} catch (e) {
		console.error('[backup-offsite] failed to persist lastUpload:', e instanceof Error ? e.message : e);
	}

	return result;
}

export async function maybeRunScheduledOffsiteBackup(): Promise<void> {
	const settings = getSetting<BackupSettings>('backup');
	if (!settings || !settings.offsite?.enabled) return;
	if (settings.offsite.schedule === 'manual') return;

	const lastAt = settings.offsite.lastUpload?.at;
	const lastMs = lastAt ? parseSqliteUtc(lastAt) : 0;
	const intervalMs = settings.offsite.schedule === 'weekly' ? 7 * 86400_000 : 86400_000;
	if (Date.now() - lastMs < intervalMs * 0.9) return;

	await runOffsiteBackup();
}

// Sentinel files are left in place — operators who want auto-cleanup
// should configure a bucket lifecycle rule that expires
// `_itcake-connectivity-test-*` after a day.
export async function testOffsiteBackupConfig(): Promise<UploadResult> {
	const settings = getSetting<BackupSettings>('backup');
	if (!settings || !settings.offsite?.enabled) return { ok: false, error: 'off-site backup not enabled' };
	const sentinel = Buffer.from(`itcake-test-${Date.now()}\n`);
	const remoteName = `_itcake-connectivity-test-${Date.now()}.txt`;
	try {
		if (settings.offsite.target === 's3') {
			const s3 = settings.offsite.s3;
			const secret = passthroughOrDecrypt(s3.secretAccessKey);
			if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !secret) throw new Error('S3 settings incomplete');
			await s3Put({
				endpoint: s3.endpoint, region: s3.region || 'us-east-1', bucket: s3.bucket,
				accessKeyId: s3.accessKeyId, secretAccessKey: secret,
				key: (s3.pathPrefix || '') + remoteName, body: sentinel
			});
		} else if (settings.offsite.target === 'webdav') {
			const wd = settings.offsite.webdav;
			const pass = passthroughOrDecrypt(wd.password);
			if (!wd.url || !wd.username || !pass) throw new Error('WebDAV settings incomplete');
			await webdavPut({ url: wd.url, username: wd.username, password: pass, key: remoteName, body: sentinel });
		} else {
			throw new Error(`unknown off-site target: ${settings.offsite.target}`);
		}
		return { ok: true, sizeBytes: sentinel.length, remoteKey: remoteName };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
