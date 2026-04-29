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
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { env } from '$env/dynamic/private';
import { db, getSetting, setSetting } from '$lib/server/db.js';
import { isEncryptedBackup } from '$lib/server/backup-crypto.js';
import { encryptField, decryptField, isEncryptedField } from '$lib/server/field-crypto.js';
import { BACKUP_DIR } from '$lib/server/data-dir.js';
import { validateHostname, resolveAndValidate } from '$lib/server/checks/validate-target.js';
import { createBackup, withBackupLock, BackupInProgressError } from '$services/backups.js';
import type { BackupSettings } from '$lib/types.js';

/**
 * Validate the target URL against SSRF policy:
 *   - Hostname charset (rejects option-injection)
 *   - IP must not be in the blocklist (loopback / private / link-local /
 *     multicast / metadata / NAT64 / 6to4 / Teredo / IPv6 ULA)
 *   - In production, refuse plaintext http:// (creds + body would be
 *     blasted in clear; the only legitimate self-hosted use case is a
 *     LAN MinIO behind TLS-terminating proxy)
 *
 * Returns the validated IP so callers can pin DNS via a custom http.Agent
 * lookup, closing the rebinding TOCTOU window.
 */
async function validateOffsiteUrl(url: string, label: string): Promise<{ pinnedIp: string; isHttps: boolean }> {
	if (!/^https?:\/\//i.test(url)) throw new Error(`${label} URL must be http(s)`);
	const isHttps = url.toLowerCase().startsWith('https://');
	if (!isHttps && env.NODE_ENV === 'production') {
		throw new Error(`${label} requires https:// in production (would leak credentials in clear)`);
	}
	const parsed = new URL(url);
	validateHostname(parsed.hostname);
	const pinnedIp = await resolveAndValidate(parsed.hostname);
	return { pinnedIp, isHttps };
}

/** Build a DNS-pinning http(s).Agent that forces all connects to the
 *  validated IP, regardless of any subsequent DNS rebinding. */
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

/** Make a PUT request via the pinning agent. Returns status code; on
 *  failure, throws a generic error WITHOUT including the response body
 *  to avoid leaking probed-service responses back to the operator UI
 *  (which would turn the test endpoint into an SSRF probe). */
async function pinnedRequest(
	method: 'PUT',
	fullUrl: string,
	pinnedIp: string,
	isHttps: boolean,
	headers: Record<string, string>,
	body: Buffer,
	timeoutMs: number,
	label: string
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
				// Drain (cap to 64 KiB to avoid trickle-DoS) and resolve.
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
	const { pinnedIp, isHttps } = await validateOffsiteUrl(opts.endpoint, 'S3 endpoint');
	const url = new URL(opts.endpoint);
	// Force path-style addressing — works for every provider (B2, R2, MinIO);
	// AWS itself also accepts it, deprecation only affects new buckets in
	// some regions. Percent-encode each path segment so spaces / `+` / non-
	// ASCII don't desync the canonical URI from the URL fetch builds.
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
		'',                  // canonical query string (none)
		canonicalHeaders,
		signedHeaders,
		payloadHash
	].join('\n');

	const stringToSign = [algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey = sigV4SigningKey(opts.secretAccessKey, dateStamp, opts.region, service);
	const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

	const auth = `${algorithm} Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const status = await pinnedRequest('PUT', fullUrl, pinnedIp, isHttps, { ...headers, authorization: auth }, opts.body, 120_000, 'S3');
	if (status < 200 || status >= 300) {
		// Generic error — never include response body. The test endpoint
		// exposes errors to UI, so leaking probed-service banners would
		// turn off-site connectivity testing into an SSRF oracle.
		throw new Error(`S3 PUT failed (status ${status})`);
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
	const { pinnedIp, isHttps } = await validateOffsiteUrl(opts.url, 'WebDAV');
	const base = opts.url.endsWith('/') ? opts.url : opts.url + '/';
	// Encode per path segment in case the key ever contains slashes;
	// today opts.key is a flat filename but the API allows it.
	const encodedKey = opts.key.split('/').map(encodeURIComponent).join('/');
	const target = base + encodedKey;
	const auth = 'Basic ' + Buffer.from(`${opts.username}:${opts.password}`).toString('base64');

	const status = await pinnedRequest('PUT', target, pinnedIp, isHttps, {
		'Authorization': auth,
		'Content-Type': 'application/octet-stream'
	}, opts.body, 120_000, 'WebDAV');
	// 200 OK, 201 Created, 204 No Content all indicate success on WebDAV.
	if (status !== 200 && status !== 201 && status !== 204) {
		throw new Error(`WebDAV PUT failed (status ${status})`);
	}
}

// ── Public API ────────────────────────────────────────────────────────

function passthroughOrDecrypt(value: string): string {
	return isEncryptedField(value) ? decryptField(value) : value;
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
		// Acquire the shared backup mutex so a manual "Backup now" click and
		// a scheduled off-site upload don't run createBackup() concurrently
		// (the underlying _tmp_<timestamp>.db path collides at second
		// precision). The lock is released as soon as createBackup
		// finishes; the upload itself runs outside the lock so it doesn't
		// block another backup attempt for the duration of the network
		// transfer.
		const info = await withBackupLock(() => createBackup());
		const localPath = path.join(BACKUP_DIR, info.filename);
		if (!existsSync(localPath)) throw new Error('backup file vanished after createBackup');
		// Buffer.from copy to normalize the readFileSync result to a
		// non-shared backing buffer — Node 22+ types distinguish
		// NonSharedBuffer from Buffer<ArrayBufferLike>.
		const body: Buffer = Buffer.from(readFileSync(localPath));
		// Trust createBackup() as the single encryption boundary. When a
		// backup passphrase is configured, info.filename already ends in
		// `.zip.enc` and the bytes carry the ITCAKE-ENC-1 header. Wrapping
		// again here would produce a `.zip.enc.enc` artifact with two
		// nested envelopes — the off-site copy would no longer round-trip
		// through restoreBackup() / decryptBackup() and operators would
		// silently lose their off-site safety net.
		const remoteName = info.filename;
		// Defense-in-depth: if a passphrase is configured but the file we
		// read isn't encrypted, that's an inconsistency in createBackup()
		// — refuse to upload plaintext to a remote bucket.
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
 * misconfiguration during a real backup. Uploads a small sentinel
 * file (no full backup). The sentinel is left in place — implementing
 * DELETE would double the auth-signing surface (separate SigV4 path
 * for S3, plus WebDAV variants) for marginal benefit. Operators who
 * want auto-cleanup should configure a bucket lifecycle rule that
 * expires `_itcake-connectivity-test-*` after a day.
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
