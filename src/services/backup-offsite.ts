/**
 * Off-site backup uploader. Two transport targets:
 *
 *   - S3-compatible (AWS S3, Backblaze B2, Cloudflare R2, MinIO, Wasabi …)
 *     Implemented manually via fetch + AWS SigV4 to avoid pulling in the
 *     full aws-sdk (~30 MB) for one PUT call. Public-cloud creds are
 *     stored field-encrypted at rest under SESSION_SECRET.
 *   - WebDAV (Nextcloud, Hetzner Storage Box, ownCloud, Apache mod_dav).
 *     Plain HTTP basic auth over TLS — same cred protection.
 *
 * Schedule: cron tick checks the configured cadence (`daily` / `weekly` /
 * `manual`). The actual upload happens in-band on the tick that sees a
 * due window — typical backups are tens of MB so this is fine, and
 * doing it inline keeps the failure visible in the response.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { db, getSetting, setSetting } from '$lib/server/db.js';
import { encryptBackup } from '$lib/server/backup-crypto.js';
import { encryptField, decryptField } from '$lib/server/field-crypto.js';
import { BACKUP_DIR } from '$lib/server/data-dir.js';
import { createBackup } from '$services/backups.js';
import type { BackupSettings } from '$lib/types.js';

interface UploadResult {
	ok: boolean;
	error?: string;
	sizeBytes?: number;
	remoteKey?: string;
}

// ── SigV4 (S3) ────────────────────────────────────────────────────────

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
	if (!/^https?:\/\//i.test(opts.endpoint)) throw new Error('S3 endpoint must be http(s)');
	const url = new URL(opts.endpoint);
	// Force path-style addressing — works for every provider (B2, R2, MinIO);
	// AWS itself also accepts it, deprecation only affects new buckets in
	// some regions.
	const host = url.host;
	const objectPath = `/${opts.bucket}/${opts.key.replace(/^\//, '')}`;
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
		'',                  // canonical query string (none)
		canonicalHeaders,
		signedHeaders,
		payloadHash
	].join('\n');

	const stringToSign = [algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey = sigV4SigningKey(opts.secretAccessKey, dateStamp, opts.region, service);
	const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

	const auth = `${algorithm} Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const res = await fetch(fullUrl, {
		method: 'PUT',
		headers: { ...headers, authorization: auth },
		body: new Uint8Array(opts.body),
		signal: AbortSignal.timeout(120_000)
	});
	if (!res.ok) {
		const txt = await res.text().catch(() => '');
		throw new Error(`S3 PUT ${res.status}: ${txt.slice(0, 400)}`);
	}
}

// ── WebDAV ────────────────────────────────────────────────────────────

interface WebdavPutOpts {
	url: string;          // base URL, may end with /
	username: string;
	password: string;
	key: string;          // file name (relative)
	body: Buffer;
}

async function webdavPut(opts: WebdavPutOpts): Promise<void> {
	if (!/^https?:\/\//i.test(opts.url)) throw new Error('WebDAV URL must be http(s)');
	const base = opts.url.endsWith('/') ? opts.url : opts.url + '/';
	const target = base + encodeURIComponent(opts.key);
	const auth = 'Basic ' + Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
	const res = await fetch(target, {
		method: 'PUT',
		headers: {
			'Authorization': auth,
			'Content-Type': 'application/octet-stream'
		},
		body: new Uint8Array(opts.body),
		signal: AbortSignal.timeout(120_000)
	});
	// 200 OK, 201 Created, 204 No Content all indicate success on WebDAV.
	if (!res.ok && res.status !== 201 && res.status !== 204) {
		const txt = await res.text().catch(() => '');
		throw new Error(`WebDAV PUT ${res.status}: ${txt.slice(0, 400)}`);
	}
}

// ── Public API ────────────────────────────────────────────────────────

function passthroughOrDecrypt(value: string): string {
	return value && value.startsWith('enc') ? decryptField(value) : value;
}

/** Encrypt secret credentials before persisting to settings. */
export function encryptBackupSettingsForStorage(settings: BackupSettings): BackupSettings {
	const out = JSON.parse(JSON.stringify(settings)) as BackupSettings;
	if (out.encryptionPassphrase && !out.encryptionPassphrase.startsWith('enc')) {
		out.encryptionPassphrase = encryptField(out.encryptionPassphrase);
	}
	if (out.offsite?.s3?.secretAccessKey && !out.offsite.s3.secretAccessKey.startsWith('enc')) {
		out.offsite.s3.secretAccessKey = encryptField(out.offsite.s3.secretAccessKey);
	}
	if (out.offsite?.webdav?.password && !out.offsite.webdav.password.startsWith('enc')) {
		out.offsite.webdav.password = encryptField(out.offsite.webdav.password);
	}
	return out;
}

/**
 * Run a one-shot upload of a fresh backup according to the configured
 * target. Used by both the cron tick and the "Upload now" admin button.
 *
 * Side effects:
 *   - createBackup() writes a new ZIP into BACKUP_DIR
 *   - The ZIP (encrypted with the configured passphrase if set) is PUT
 *     to the configured target
 *   - settings.backup.offsite.lastUpload is updated with the result
 */
export async function runOffsiteBackup(): Promise<UploadResult> {
	const settings = getSetting<BackupSettings>('backup');
	if (!settings || !settings.offsite?.enabled) {
		return { ok: false, error: 'off-site backup not enabled' };
	}

	let result: UploadResult = { ok: false };
	try {
		const info = await createBackup();
		const localPath = path.join(BACKUP_DIR, info.filename);
		if (!existsSync(localPath)) throw new Error('backup file vanished after createBackup');
		// Buffer.from copy to normalize the readFileSync result to a
		// non-shared backing buffer — Node 22+ types distinguish
		// NonSharedBuffer from Buffer<ArrayBufferLike>.
		let body: Buffer = Buffer.from(readFileSync(localPath));
		let remoteName = info.filename;

		const passphrase = passthroughOrDecrypt(settings.encryptionPassphrase || '');
		if (passphrase) {
			body = encryptBackup(body, passphrase);
			remoteName = info.filename + '.enc';
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
		result = { ok: false, error: e instanceof Error ? e.message : String(e) };
	}

	// Persist last-upload status — visible in admin UI and useful for an
	// external "is your backup pipeline healthy?" check.
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

/**
 * Cron tick. Decides whether a scheduled run is due based on the
 * configured cadence and `lastUpload.at`. `manual` means "never auto" —
 * operator triggers via API. Called from hooks.server.ts on the daily
 * tick (24h interval), but cheap enough that frequent calls are fine.
 */
export async function maybeRunScheduledOffsiteBackup(): Promise<void> {
	const settings = getSetting<BackupSettings>('backup');
	if (!settings || !settings.offsite?.enabled) return;
	if (settings.offsite.schedule === 'manual') return;

	const lastAt = settings.offsite.lastUpload?.at;
	const lastMs = lastAt ? new Date(lastAt.endsWith('Z') ? lastAt : lastAt + 'Z').getTime() : 0;
	const intervalMs = settings.offsite.schedule === 'weekly' ? 7 * 86400_000 : 86400_000;
	if (Date.now() - lastMs < intervalMs * 0.9) return; // 10% slack on the cadence

	await runOffsiteBackup();
}

/**
 * Quick connectivity test for the configured target. Useful as a "Test
 * connection" admin action so operators don't only learn about a
 * misconfiguration during a real backup. Uploads a 32-byte sentinel
 * file, no full backup.
 */
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
