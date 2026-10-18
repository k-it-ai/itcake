import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { NODE_ENV } from '$app/env/private';
import { getSetting, setSetting, parseSqliteUtc } from '#lib/server/db.js';
import { isEncryptedBackup } from '#lib/server/backup-crypto.js';
import { BACKUP_DIR } from '#lib/server/data-dir.js';
import { resolveTarget } from '#lib/server/checks/validate-target.js';
import { createBackup, withBackupLock, BackupInProgressError } from '#services/backups.js';
import { verifyBackupIntegrity, recomputeRecoveryReadiness } from '#services/backup-verification.js';
import { resolveOffsiteCredential } from './offsite-credential.js';
import type { BackupSettings } from '#lib/types.js';

async function validateOffsiteUrl(url: string, label: string): Promise<{ pinnedIp: string; isHttps: boolean }> {
	if (!/^https?:\/\//i.test(url)) throw new Error(`${label} URL must be http(s)`);
	const isHttps = url.toLowerCase().startsWith('https://');
	if (!isHttps && NODE_ENV === 'production') {
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

async function pinnedRequest(
	method: 'PUT' | 'GET' | 'DELETE' | 'PROPFIND',
	fullUrl: string,
	pinnedIp: string,
	isHttps: boolean,
	headers: Record<string, string>,
	body: Buffer,
	timeoutMs: number
): Promise<{ status: number; body: string }> {
	const agent = pinningAgent(pinnedIp, isHttps);
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			const mod = isHttps ? https : http;
			const req = mod.request(fullUrl, {
				method,
				agent,
				signal: controller.signal,
				headers
			}, (res) => {
				const chunks: Buffer[] = [];
				let drained = 0;
				res.on('data', (c: Buffer) => {
					drained += c.length;
					if (drained > 4 * 1024 * 1024) { req.destroy(new Error('response body too large')); return; }
					chunks.push(c);
				});
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
				res.on('error', reject);
			});
			req.on('error', reject);
			req.end(new Uint8Array(body));
		});
		clearTimeout(timer);
		return response;
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

/** RFC 3986 encoding required by SigV4 (encodeURIComponent leaves !'()* alone). */
function sigV4Encode(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
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

interface S3Conn {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

interface RemoteObject {
	key: string;
	lastModifiedMs: number;
}

/** Uploaded backups only — never the connectivity-test sentinel or stray files. */
const REMOTE_BACKUP_NAME = /^backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/;

function s3SignedHeaders(opts: {
	method: string;
	host: string;
	objectPath: string;
	canonicalQuery: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	payloadHash: string;
	contentType?: string;
}): Record<string, string> {
	const now = new Date();
	const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
	const dateStamp = amzDate.slice(0, 8);
	const credentialScope = `${dateStamp}/${opts.region}/s3/aws4_request`;
	const headers: Record<string, string> = {
		'host': opts.host,
		'x-amz-content-sha256': opts.payloadHash,
		'x-amz-date': amzDate
	};
	if (opts.contentType) headers['content-type'] = opts.contentType;

	const signedHeaderKeys = Object.keys(headers).map(h => h.toLowerCase()).sort();
	const canonicalHeaders = signedHeaderKeys.map(h => `${h}:${headers[h]}\n`).join('');
	const signedHeaders = signedHeaderKeys.join(';');

	const canonicalRequest = [
		opts.method,
		opts.objectPath,
		opts.canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		opts.payloadHash
	].join('\n');

	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey = sigV4SigningKey(opts.secretAccessKey, dateStamp, opts.region, 's3');
	const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

	return {
		...headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
	};
}

async function s3Request(
	s3: S3Conn,
	method: 'PUT' | 'GET' | 'DELETE',
	key: string,
	query: Record<string, string>,
	body?: Buffer,
	timeoutMs = 120_000
): Promise<{ status: number; body: string }> {
	const { pinnedIp, isHttps } = await validateOffsiteUrl(s3.endpoint, 'S3 endpoint');
	const url = new URL(s3.endpoint);
	const host = url.host;
	const trimmed = key.replace(/^\//, '');
	const encodedBucket = sigV4Encode(s3.bucket);
	const objectPath = trimmed
		? `/${encodedBucket}/${trimmed.split('/').map(sigV4Encode).join('/')}`
		: `/${encodedBucket}`;
	const canonicalQuery = Object.keys(query).sort()
		.map(k => `${sigV4Encode(k)}=${sigV4Encode(query[k])}`)
		.join('&');
	const fullUrl = `${url.protocol}//${host}${objectPath}${canonicalQuery ? `?${canonicalQuery}` : ''}`;

	const payload = body ?? Buffer.alloc(0);
	const headers = s3SignedHeaders({
		method,
		host,
		objectPath,
		canonicalQuery,
		region: s3.region || 'us-east-1',
		accessKeyId: s3.accessKeyId,
		secretAccessKey: s3.secretAccessKey,
		payloadHash: sha256Hex(payload),
		contentType: method === 'PUT' ? 'application/octet-stream' : undefined
	});

	return pinnedRequest(method, fullUrl, pinnedIp, isHttps, headers, payload, timeoutMs);
}

async function s3Put(opts: S3PutOpts): Promise<void> {
	const { status } = await s3Request({
		endpoint: opts.endpoint,
		region: opts.region,
		bucket: opts.bucket,
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey
	}, 'PUT', opts.key, {}, opts.body);
	if (status < 200 || status >= 300) {
		throw new Error(`S3 PUT failed (status ${status})`);
	}
}

async function s3ListBackups(s3: S3Conn, prefix: string): Promise<RemoteObject[]> {
	const out: RemoteObject[] = [];
	let token: string | undefined;
	for (let page = 0; page < 100; page++) {
		const query: Record<string, string> = { 'list-type': '2', prefix };
		if (token) query['continuation-token'] = token;
		const { status, body } = await s3Request(s3, 'GET', '', query, undefined, 60_000);
		if (status !== 200) throw new Error(`S3 LIST failed (status ${status})`);
		for (const m of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
			const key = decodeXmlEntities(m[1].match(/<Key>([^<]*)<\/Key>/)?.[1] ?? '');
			const lastModified = m[1].match(/<LastModified>([^<]*)<\/LastModified>/)?.[1] ?? '';
			if (!key) continue;
			out.push({ key, lastModifiedMs: Date.parse(lastModified) });
		}
		const next = body.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1];
		token = next ? decodeXmlEntities(next) : undefined;
		if (!token) break;
	}
	return out;
}

async function s3DeleteObject(s3: S3Conn, key: string): Promise<void> {
	const { status } = await s3Request(s3, 'DELETE', key, {}, undefined, 60_000);
	// 404 means it is already gone — the goal state.
	if (status !== 204 && status !== 200 && status !== 404) {
		throw new Error(`S3 DELETE failed (status ${status})`);
	}
}

interface WebdavPutOpts {
	url: string;
	username: string;
	password: string;
	key: string;
	body: Buffer;
}

interface WebdavConn {
	url: string;
	username: string;
	password: string;
}

async function webdavPut(opts: WebdavPutOpts): Promise<void> {
	const { pinnedIp, isHttps } = await validateOffsiteUrl(opts.url, 'WebDAV');
	const base = opts.url.endsWith('/') ? opts.url : opts.url + '/';
	const encodedKey = opts.key.split('/').map(encodeURIComponent).join('/');
	const target = base + encodedKey;
	const auth = 'Basic ' + Buffer.from(`${opts.username}:${opts.password}`).toString('base64');

	const { status } = await pinnedRequest('PUT', target, pinnedIp, isHttps, {
		'Authorization': auth,
		'Content-Type': 'application/octet-stream'
	}, opts.body, 120_000);
	if (status !== 200 && status !== 201 && status !== 204) {
		throw new Error(`WebDAV PUT failed (status ${status})`);
	}
}

const WEBDAV_PROPFIND_BODY = '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getlastmodified/></prop></propfind>';

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

async function webdavListBackups(wd: WebdavConn): Promise<RemoteObject[]> {
	const { pinnedIp, isHttps } = await validateOffsiteUrl(wd.url, 'WebDAV');
	const base = wd.url.endsWith('/') ? wd.url : wd.url + '/';
	const auth = 'Basic ' + Buffer.from(`${wd.username}:${wd.password}`).toString('base64');
	const { status, body } = await pinnedRequest('PROPFIND', base, pinnedIp, isHttps, {
		'Authorization': auth,
		'Depth': '1',
		'Content-Type': 'application/xml'
	}, Buffer.from(WEBDAV_PROPFIND_BODY), 60_000);
	if (status !== 207) throw new Error(`WebDAV PROPFIND failed (status ${status})`);

	const baseUrl = new URL(base);
	const out: RemoteObject[] = [];
	for (const m of body.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
		const href = decodeXmlEntities(m[1].match(/<(?:[\w-]+:)?href\b[^>]*>([^<]*)<\//i)?.[1] ?? '');
		const lastModified = m[1].match(/<(?:[\w-]+:)?getlastmodified\b[^>]*>([^<]*)<\//i)?.[1] ?? '';
		if (!href) continue;
		let target: URL;
		try { target = new URL(href, baseUrl); } catch { continue; }
		// Only same-origin entries under the configured folder.
		if (target.origin !== baseUrl.origin || !target.pathname.startsWith(baseUrl.pathname)) continue;
		const name = target.pathname.slice(target.pathname.lastIndexOf('/') + 1);
		if (!name) continue;
		out.push({ key: target.toString(), lastModifiedMs: Date.parse(lastModified) });
	}
	return out;
}

async function webdavDeleteObject(wd: WebdavConn, keyUrl: string): Promise<void> {
	const base = wd.url.endsWith('/') ? wd.url : wd.url + '/';
	const baseUrl = new URL(base);
	const target = new URL(keyUrl);
	if (target.origin !== baseUrl.origin || !target.pathname.startsWith(baseUrl.pathname)) {
		throw new Error('refusing to delete outside the configured WebDAV folder');
	}
	const { pinnedIp, isHttps } = await validateOffsiteUrl(wd.url, 'WebDAV');
	const auth = 'Basic ' + Buffer.from(`${wd.username}:${wd.password}`).toString('base64');
	const { status } = await pinnedRequest('DELETE', target.toString(), pinnedIp, isHttps, {
		'Authorization': auth
	}, Buffer.alloc(0), 60_000);
	if (status !== 200 && status !== 204 && status !== 404) {
		throw new Error(`WebDAV DELETE failed (status ${status})`);
	}
}

/** Keeps the newest keepMin backups; only deletes backup-named files with a parseable old timestamp. */
export function selectExpiredRemoteBackups(
	objects: RemoteObject[],
	opts: { keepMin?: number; retentionDays?: number; now?: number } = {}
): RemoteObject[] {
	const keepMin = Math.max(1, opts.keepMin ?? 7);
	const retentionDays = Math.max(1, opts.retentionDays ?? 30);
	const cutoff = (opts.now ?? Date.now()) - retentionDays * 86400_000;
	const candidates = objects
		.filter(o => REMOTE_BACKUP_NAME.test(o.key.split('/').pop() ?? ''))
		.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
	return candidates
		.slice(keepMin)
		.filter(o => Number.isFinite(o.lastModifiedMs) && o.lastModifiedMs < cutoff);
}

async function pruneRemoteBackups(settings: BackupSettings): Promise<void> {
	const retentionDays = Number(settings.offsite?.retentionDays);
	if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;

	let objects: RemoteObject[];
	let remove: (key: string) => Promise<void>;
	if (settings.offsite?.target === 's3') {
		const s3 = settings.offsite.s3;
		const secret = resolveOffsiteCredential(s3.secretAccessKey || '');
		if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !secret) return;
		const conn: S3Conn = {
			endpoint: s3.endpoint,
			region: s3.region || 'us-east-1',
			bucket: s3.bucket,
			accessKeyId: s3.accessKeyId,
			secretAccessKey: secret
		};
		objects = await s3ListBackups(conn, s3.pathPrefix || '');
		remove = (key) => s3DeleteObject(conn, key);
	} else if (settings.offsite?.target === 'webdav') {
		const wd = settings.offsite.webdav;
		const pass = resolveOffsiteCredential(wd.password || '');
		if (!wd.url || !wd.username || !pass) return;
		const conn: WebdavConn = { url: wd.url, username: wd.username, password: pass };
		objects = await webdavListBackups(conn);
		remove = (key) => webdavDeleteObject(conn, key);
	} else {
		return;
	}

	const expired = selectExpiredRemoteBackups(objects, { retentionDays });
	for (const obj of expired) {
		try {
			await remove(obj.key);
			console.info(`[backup-offsite] pruned remote backup ${obj.key}`);
		} catch (e) {
			console.warn(`[backup-offsite] failed to prune ${obj.key}:`, e instanceof Error ? e.message : e);
		}
	}
}

export async function runOffsiteBackup(): Promise<UploadResult> {
	const settings = getSetting<BackupSettings>('backup');
	if (!settings || !settings.offsite?.enabled) {
		return { ok: false, error: 'off-site backup not enabled' };
	}

	let result: UploadResult = { ok: false };
	try {
		const info = await withBackupLock(() => createBackup());
		const localPath = path.join(BACKUP_DIR, info.filename);
		if (!existsSync(localPath)) throw new Error('backup file vanished after createBackup');
		const body: Buffer = Buffer.from(readFileSync(localPath));
		const remoteName = info.filename;
		const passphraseConfigured = !!resolveOffsiteCredential(settings.encryptionPassphrase || '');
		if (passphraseConfigured && !isEncryptedBackup(body)) {
			throw new Error('backup passphrase is configured but the local backup is not encrypted');
		}

		const target = settings.offsite.target;
		if (target === 's3') {
			const s3 = settings.offsite.s3;
			const secret = resolveOffsiteCredential(s3.secretAccessKey || '');
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
			const pass = resolveOffsiteCredential(wd.password || '');
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

	if (result.ok && result.remoteKey) {
		const localFilename = result.remoteKey.replace(/^.*\//, '');
		try { await verifyBackupIntegrity(localFilename); }
		catch (e) { console.warn('[backup-offsite] post-upload integrity check failed:', e instanceof Error ? e.message : e); }
	}

	if (result.ok) {
		try { await pruneRemoteBackups(settings); }
		catch (e) { console.warn('[backup-offsite] retention prune failed:', e instanceof Error ? e.message : e); }
	}

	try { recomputeRecoveryReadiness(); }
	catch (e) { console.warn('[backup-offsite] readiness recompute failed:', e instanceof Error ? e.message : e); }

	return result;
}

export async function maybeRunScheduledOffsiteBackup(): Promise<void> {
	const settings = getSetting<BackupSettings>('backup');
	if (!settings || !settings.offsite?.enabled) return;
	if (settings.offsite.schedule === 'manual') return;

	const lastAt = settings.offsite.lastUpload?.at;
	const rawLastMs = lastAt ? parseSqliteUtc(lastAt) : 0;
	// Clamp to now; a future timestamp from clock skew would otherwise suppress the schedule.
	const lastMs = Math.min(rawLastMs, Date.now());
	const intervalMs = settings.offsite.schedule === 'weekly' ? 7 * 86400_000 : 86400_000;
	if (Date.now() - lastMs < intervalMs * 0.9) return;

	await runOffsiteBackup();
}

export async function testOffsiteBackupConfig(): Promise<UploadResult> {
	const settings = getSetting<BackupSettings>('backup');
	if (!settings || !settings.offsite?.enabled) return { ok: false, error: 'off-site backup not enabled' };
	const sentinel = Buffer.from(`itcake-test-${Date.now()}\n`);
	const remoteName = `_itcake-connectivity-test-${Date.now()}.txt`;
	try {
		if (settings.offsite.target === 's3') {
			const s3 = settings.offsite.s3;
			const secret = resolveOffsiteCredential(s3.secretAccessKey || '');
			if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !secret) throw new Error('S3 settings incomplete');
			await s3Put({
				endpoint: s3.endpoint, region: s3.region || 'us-east-1', bucket: s3.bucket,
				accessKeyId: s3.accessKeyId, secretAccessKey: secret,
				key: (s3.pathPrefix || '') + remoteName, body: sentinel
			});
		} else if (settings.offsite.target === 'webdav') {
			const wd = settings.offsite.webdav;
			const pass = resolveOffsiteCredential(wd.password || '');
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
