import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { env } from '$env/dynamic/private';
// @ts-ignore — guacamole-lite ships JS without bundled types
import GuacamoleLite from 'guacamole-lite';
import { getSetting, parseSqliteUtc } from '$lib/server/db.js';
import { encryptField, decryptField, isEncryptedField } from '$lib/server/field-crypto.js';
import { log } from '$lib/server/log.js';
import { safeEnv } from '$lib/server/safe-spawn.js';
import {
	whichPath,
	guacdPath,
	guacencPath,
	sudoPath,
	aptGetPath,
	dnfPath,
	pacmanPath,
	apkPath,
	brewPath
} from '$lib/server/system-binary.js';
import { DATA_DIR } from '$lib/server/data-dir.js';
import { getAgentDataRaw } from '$services/agents.js';
import {
	createRemoteSession,
	consumeRemoteSession,
	getRemoteSession,
	claimRemoteSessionStart,
	recordRemoteSessionConnected,
	markRemoteSessionEnded
} from '$services/remote-sessions.js';
import type {
	AgentRemoteDesktop,
	RemoteDesktopSettings,
	RemoteDesktopProtocol
} from '$lib/types.js';

const execFileAsync = promisify(execFile);

interface CmdResult { ok: boolean; stdout: string; stderr: string }

async function runArgv(file: string, args: string[], timeoutMs = 600_000): Promise<CmdResult> {
	try {
		const { stdout, stderr } = await execFileAsync(file, args, {
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
			env: safeEnv()
		});
		return { ok: true, stdout, stderr };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, stdout: err.stdout || '', stderr: err.stderr || err.message || '' };
	}
}

function rdpAad(agentId: string, field: 'password' | 'privateKey'): string {
	return `agent.remoteDesktop.${field}:${agentId}`;
}

export function encryptAgentRemoteDesktop(agentId: string, profile: AgentRemoteDesktop): AgentRemoteDesktop {
	const out: AgentRemoteDesktop = { ...profile };
	if (out.password && !isEncryptedField(out.password)) {
		out.password = encryptField(out.password, rdpAad(agentId, 'password'));
	}
	if (out.privateKey && !isEncryptedField(out.privateKey)) {
		out.privateKey = encryptField(out.privateKey, rdpAad(agentId, 'privateKey'));
	}
	return out;
}

function decryptAgentRemoteDesktop(agentId: string, profile: AgentRemoteDesktop): AgentRemoteDesktop {
	const out: AgentRemoteDesktop = { ...profile };
	if (out.password && isEncryptedField(out.password)) {
		out.password = decryptField(out.password, rdpAad(agentId, 'password'));
	}
	if (out.privateKey && isEncryptedField(out.privateKey)) {
		out.privateKey = decryptField(out.privateKey, rdpAad(agentId, 'privateKey'));
	}
	return out;
}

export function getAgentRemoteDesktop(agentId: string): AgentRemoteDesktop | null {
	const data = getAgentDataRaw(agentId);
	const raw = (data?.remoteDesktop as AgentRemoteDesktop | undefined) ?? null;
	if (!raw) return null;
	return decryptAgentRemoteDesktop(agentId, raw);
}

const TOKEN_KEY_INFO = 'itcake-guacamole-token-v1';
const TOKEN_KEY_BYTES = 32;

let cachedTokenKey: Buffer | null | undefined;
let cachedTokenHmacKey: Buffer | null | undefined;

function tokenKey(): Buffer | null {
	if (cachedTokenKey !== undefined) return cachedTokenKey;
	const secret = env.SESSION_SECRET;
	if (!secret) { cachedTokenKey = null; return null; }
	cachedTokenKey = crypto.scryptSync(secret, TOKEN_KEY_INFO, TOKEN_KEY_BYTES);
	return cachedTokenKey;
}

// Key-separated HMAC for the outer wrap. Distinct scrypt info so the
// HMAC key cannot be confused with the AES key under any code path.
function tokenHmacKey(): Buffer | null {
	if (cachedTokenHmacKey !== undefined) return cachedTokenHmacKey;
	const secret = env.SESSION_SECRET;
	if (!secret) { cachedTokenHmacKey = null; return null; }
	cachedTokenHmacKey = crypto.scryptSync(secret, 'itcake-guac-token-hmac:1', 32);
	return cachedTokenHmacKey;
}

interface GuacTokenPayload {
	connection: { type: RemoteDesktopProtocol; settings: Record<string, never> };
	itcakeSessionId: string;
}

function resolveConnectionSettings(
	profile: AgentRemoteDesktop,
	host: string,
	sessionId: string,
	recording: boolean
): Record<string, string | number | boolean | undefined> {
	const settings: Record<string, string | number | boolean | undefined> = {
		hostname: host,
		port: profile.port,
		username: profile.username || undefined,
		password: profile.password || undefined
	};

	if (profile.protocol === 'rdp') {
		settings['security'] = 'tls';
		settings['ignore-cert'] = profile.ignoreCert === true;
		if (profile.domain) settings['domain'] = profile.domain;
		settings['resize-method'] = 'display-update';
	} else if (profile.protocol === 'vnc') {
		settings['cursor'] = 'remote';
	} else if (profile.protocol === 'ssh') {
		if (profile.privateKey) settings['private-key'] = profile.privateKey;
	}

	if (recording) {
		const dir = path.join(DATA_DIR, 'recordings', sessionId);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
		settings['recording-path'] = dir;
		settings['recording-name'] = 'session.guac';
		settings['create-recording-path'] = true;
	}
	return settings;
}

function encryptGuacToken(payload: GuacTokenPayload): string {
	const key = tokenKey();
	const hmacKey = tokenHmacKey();
	if (!key || !hmacKey) throw new Error('SESSION_SECRET unset; cannot mint Guacamole token');
	// Inner blob is the legacy guacamole-lite format (CBC + IV, JSON-wrapped,
	// base64-encoded). We keep it byte-for-byte compatible because
	// guacamole-lite hard-codes AES-CBC decrypt — we don't fork the lib.
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64');
	const inner = Buffer.from(JSON.stringify({ iv: iv.toString('base64'), value: ciphertext }), 'utf8').toString('base64');
	// Outer HMAC-SHA256 wrap binds the CBC payload to its operator-issued
	// identity. The WS verifyClient strips this wrap and substitutes the
	// inner token in the request URL before guacamole-lite's CBC decrypt
	// runs — so a padding-oracle / bit-flip attempt fails at the HMAC
	// stage and never reaches the malleable cipher.
	const mac = crypto.createHmac('sha256', hmacKey).update(inner).digest('hex');
	return Buffer.from(JSON.stringify({ mac, inner }), 'utf8').toString('base64');
}

export function issueRemoteSession(input: {
	agentId: string;
	userId: string;
	clientIp: string;
	userAgent: string;
}): { sessionId: string; token: string; expiresAt: string; protocol: RemoteDesktopProtocol } {
	const settings = getSetting<RemoteDesktopSettings>('remoteDesktop');
	if (!settings || !settings.enabled) throw new Error('Remote desktop is disabled in settings');
	const profile = getAgentRemoteDesktop(input.agentId);
	if (!profile) throw new Error('Agent has no remote desktop profile configured');
	if (!profile.host) {
		throw new Error('Agent remote-desktop profile has no host set; configure it explicitly (do not rely on agent-reported IP)');
	}

	const ttl = Math.min(3600, Math.max(30, settings.tokenTtlSeconds || 300));
	const session = createRemoteSession({
		agentId: input.agentId,
		userId: input.userId,
		protocol: profile.protocol,
		ttlSeconds: ttl,
		clientIp: input.clientIp,
		userAgent: input.userAgent
	});
	return {
		sessionId: session.sessionId,
		token: session.token,
		expiresAt: session.expiresAt,
		protocol: profile.protocol
	};
}

export function exchangeForGuacToken(token: string): {
	guacToken: string;
	sessionId: string;
	maxSessionMinutes: number;
} | null {
	const settings = getSetting<RemoteDesktopSettings>('remoteDesktop');
	if (!settings || !settings.enabled) return null;

	const session = consumeRemoteSession(token);
	if (!session) return null;

	const profile = getAgentRemoteDesktop(session.agentId);
	if (!profile) return null;
	if (!profile.host) return null;

	const guacToken = encryptGuacToken({
		connection: { type: profile.protocol, settings: {} },
		itcakeSessionId: session.id
	});

	return { guacToken, sessionId: session.id, maxSessionMinutes: settings.maxSessionMinutes };
}

async function probeGuacd(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
	return new Promise(resolve => {
		const sock = new net.Socket();
		let done = false;
		const finish = (ok: boolean) => {
			if (done) return;
			done = true;
			try { sock.destroy(); } catch { /* ignore */ }
			resolve(ok);
		};
		sock.setTimeout(timeoutMs);
		sock.once('connect', () => finish(true));
		sock.once('timeout', () => finish(false));
		sock.once('error', () => finish(false));
		sock.connect(port, host);
	});
}

interface GuacdStatus {
	installed: boolean;
	version: string | null;
	reachable: boolean;
	host: string;
	port: number;
}

export async function getGuacdStatus(): Promise<GuacdStatus> {
	const settings = getSetting<RemoteDesktopSettings>('remoteDesktop');
	const host = settings?.guacdHost || '127.0.0.1';
	const port = settings?.guacdPort || 4822;

	let installed = false;
	let version: string | null = null;
	const which = await runArgv(whichPath(), ['guacd'], 5_000);
	if (which.ok && which.stdout.trim()) {
		installed = true;
		const ver = await runArgv(guacdPath(), ['-v'], 5_000);
		const probe = (ver.stdout + '\n' + ver.stderr).match(/version ([\d.]+)/i);
		if (probe) version = probe[1];
	}
	const reachable = installed ? await probeGuacd(host, port) : false;
	return { installed, version, reachable, host, port };
}

interface PmRoute {
	mgr: string;
	install: { file: string; args: string[] }[];
	update: { file: string; args: string[] }[];
}

function detectPackageManager(): PmRoute | null {
	// `system-binary` returns either an absolute path (binary present on
	// disk) or the bare name as a fallback. We require an absolute path —
	// running `apt-get install` via a hijacked PATH would be a privilege
	// escalation vector even though the `which` probe would otherwise pass.
	const absolute = (p: string) => p.startsWith('/');

	if (process.platform === 'darwin') {
		const brew = brewPath();
		if (!absolute(brew)) return null;
		return {
			mgr: 'brew',
			install: [{ file: brew, args: ['install', 'guacamole-server'] }],
			update: [{ file: brew, args: ['upgrade', 'guacamole-server'] }]
		};
	}
	if (process.platform === 'linux') {
		const sudo = sudoPath();
		if (!absolute(sudo)) return null;
		const apt = aptGetPath();
		if (absolute(apt)) {
			return {
				mgr: 'apt-get',
				install: [
					{ file: sudo, args: ['-n', apt, 'update', '-qq'] },
					{ file: sudo, args: ['-n', apt, 'install', '-y', 'guacd'] }
				],
				update: [
					{ file: sudo, args: ['-n', apt, 'update', '-qq'] },
					{ file: sudo, args: ['-n', apt, 'install', '-y', '--only-upgrade', 'guacd'] }
				]
			};
		}
		const dnf = dnfPath();
		if (absolute(dnf)) {
			return {
				mgr: 'dnf',
				install: [{ file: sudo, args: ['-n', dnf, 'install', '-y', 'guacd'] }],
				update: [{ file: sudo, args: ['-n', dnf, 'upgrade', '-y', 'guacd'] }]
			};
		}
		const pacman = pacmanPath();
		if (absolute(pacman)) {
			return {
				mgr: 'pacman',
				install: [{ file: sudo, args: ['-n', pacman, '-S', '--noconfirm', 'guacd'] }],
				update: [{ file: sudo, args: ['-n', pacman, '-Syu', '--noconfirm', 'guacd'] }]
			};
		}
		const apk = apkPath();
		if (absolute(apk)) {
			return {
				mgr: 'apk',
				install: [{ file: sudo, args: ['-n', apk, 'add', '--no-cache', 'guacamole-server'] }],
				update: [{ file: sudo, args: ['-n', apk, 'upgrade', '--no-cache', 'guacamole-server'] }]
			};
		}
	}
	return null;
}

async function runRoute(steps: { file: string; args: string[] }[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	let allOut = '';
	let allErr = '';
	for (const step of steps) {
		const r = await runArgv(step.file, step.args, 600_000);
		allOut += r.stdout + '\n';
		allErr += r.stderr + '\n';
		if (!r.ok) return { ok: false, stdout: allOut, stderr: allErr };
	}
	return { ok: true, stdout: allOut, stderr: allErr };
}

export async function installGuacd(): Promise<{ ok: boolean; stdout: string; stderr: string; manager: string | null }> {
	const pm = detectPackageManager();
	if (!pm) return { ok: false, stdout: '', stderr: 'No supported package manager found (need apt/dnf/pacman/apk on Linux or brew on macOS)', manager: null };
	const r = await runRoute(pm.install);
	return { ...r, manager: pm.mgr };
}

export async function updateGuacd(): Promise<{ ok: boolean; stdout: string; stderr: string; manager: string | null }> {
	const pm = detectPackageManager();
	if (!pm) return { ok: false, stdout: '', stderr: 'No supported package manager found', manager: null };
	const r = await runRoute(pm.update);
	return { ...r, manager: pm.mgr };
}

export async function convertRecording(sessionId: string): Promise<{ ok: boolean; mp4Path: string | null; error?: string }> {
	if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
		return { ok: false, mp4Path: null, error: 'invalid session id' };
	}
	const session = getRemoteSession(sessionId);
	if (session && !session.endedAt) {
		return { ok: false, mp4Path: null, error: 'session still active; recording will become available after disconnect' };
	}
	const dir = path.join(DATA_DIR, 'recordings', sessionId);
	const guacFile = path.join(dir, 'session.guac');
	const mp4Path = guacFile + '.m4v';
	if (fs.existsSync(mp4Path)) return { ok: true, mp4Path };
	if (!fs.existsSync(guacFile)) return { ok: false, mp4Path: null, error: 'recording not found' };
	const r = await runArgv(guacencPath(), ['-s', '1280x800', '-r', '4000000', '-f', guacFile], 600_000);
	if (!r.ok || !fs.existsSync(mp4Path)) {
		return { ok: false, mp4Path: null, error: r.stderr || 'guacenc failed' };
	}
	try { fs.chmodSync(mp4Path, 0o600); } catch (e) {
		console.warn('[guacamole] mp4 chmod failed for', mp4Path, ':', e instanceof Error ? e.message : e);
	}
	try { fs.unlinkSync(guacFile); } catch (e) {
		console.warn('[guacamole] post-conversion unlink failed for', guacFile, ':', e instanceof Error ? e.message : e);
	}
	return { ok: true, mp4Path };
}

interface GuacLifecycleProxy {
	close?: () => void;
	on?: (event: string, cb: (client: GuacClientConnection) => void) => void;
}

interface MergedConnectionSettings {
	itcakeSessionId?: string;
	connection?: { type?: string; [key: string]: unknown };
	[key: string]: unknown;
}

interface GuacClientConnection {
	connectionSettings?: MergedConnectionSettings;
}

let proxyServer: GuacLifecycleProxy | null = null;
let guacUncaughtHandler: ((err: unknown) => void) | null = null;

export function startGuacamoleProxy(): void {
	if (proxyServer) return;
	const settings = getSetting<RemoteDesktopSettings>('remoteDesktop');
	if (!settings || !settings.enabled) return;

	const key = tokenKey();
	if (!key) {
		console.warn('[guacamole] proxy not started — SESSION_SECRET unset');
		return;
	}

	const port = settings.proxyPort || 4823;
	let expectedOriginNorm = '';
	try { if (env.ORIGIN) expectedOriginNorm = new URL(env.ORIGIN).origin; } catch { /* malformed */ }
	const verifyClient = (info: { origin?: string; req: { headers: Record<string, string | string[] | undefined>; url?: string } }) => {
		const raw = info.origin || '';
		// Single emit point. Every false-return path goes through this so
		// the operator sees attempted hijack flows in the structured log
		// instead of guacamole-lite swallowing the rejection silently.
		const reject = (reason: string) => {
			log.warn('[guacamole] verifyClient rejected', { reason, origin: raw.slice(0, 200) });
			return false;
		};
		if (!raw || raw === 'null') return reject('missing-or-null-origin');
		let originNorm: string;
		try { originNorm = new URL(raw).origin; } catch { return reject('malformed-origin'); }
		if (!expectedOriginNorm) {
			if (env.NODE_ENV === 'production') return reject('prod-without-expected-origin');
			let parsed: URL;
			try { parsed = new URL(raw); } catch { return reject('malformed-origin-2'); }
			if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') return reject('dev-non-loopback-origin');
		} else if (originNorm !== expectedOriginNorm) {
			return reject('origin-mismatch');
		}

		// HMAC outer-wrap verification — runs BEFORE guacamole-lite's CBC
		// decrypt. If the operator-issued token's mac doesn't match the
		// inner ciphertext, reject the upgrade. On success we mutate
		// info.req.url to substitute the inner token, so guacamole-lite
		// sees its expected single-layer CBC blob.
		const hmacKey = tokenHmacKey();
		if (!hmacKey) return reject('no-hmac-key-configured');
		const rawUrl = info.req.url || '';
		try {
			const url = new URL(rawUrl, 'http://x');
			const wrappedB64 = url.searchParams.get('token');
			if (!wrappedB64) return reject('missing-token-param');
			const parsed = JSON.parse(Buffer.from(wrappedB64, 'base64').toString('utf8')) as { mac?: unknown; inner?: unknown };
			if (typeof parsed.mac !== 'string' || typeof parsed.inner !== 'string') return reject('malformed-token-envelope');
			const expected = crypto.createHmac('sha256', hmacKey).update(parsed.inner).digest();
			const got = Buffer.from(parsed.mac, 'hex');
			if (got.length !== expected.length) return reject('mac-length-mismatch');
			if (!crypto.timingSafeEqual(got, expected)) return reject('mac-mismatch');
			// Rewrite the URL so guacamole-lite reads the inner token only.
			url.searchParams.set('token', parsed.inner);
			info.req.url = url.pathname + url.search;
		} catch {
			return reject('token-parse-failed');
		}
		return true;
	};

	// Workaround for guacamole-lite crash on malformed/expired tokens.
	// Scope the swallow to "proxy currently running" so a) the handler
	// stops eating unrelated exceptions after stopGuacamoleProxy(), and
	// b) the strict pattern match doesn't shield a future guacamole-lite
	// crash with a slightly different message. Stored as a module-level
	// reference so stopGuacamoleProxy can remove it.
	if (!guacUncaughtHandler) {
		guacUncaughtHandler = (err: unknown) => {
			if (!proxyServer) {
				// Proxy was stopped — re-throw, don't swallow.
				throw err;
			}
			const msg = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? (err.stack || '') : '';
			if (
				/Cannot read propert(y|ies) of undefined \(reading 'connection'\)/.test(msg) &&
				/guacamole-lite\/lib\/ClientConnection/.test(stack)
			) {
				console.error('[guacamole] swallowed known guacamole-lite crash on bad token:', msg);
				return;
			}
			throw err;
		};
		process.on('uncaughtException', guacUncaughtHandler);
	}

	const processConnectionSettings = (
		tokenSettings: MergedConnectionSettings,
		callback: (err: Error | null, settings?: MergedConnectionSettings) => void
	): void => {
		try {
			const sessionId = tokenSettings.itcakeSessionId;
			if (typeof sessionId !== 'string' || !sessionId) {
				return callback(new Error('missing itcakeSessionId'));
			}
			const session = getRemoteSession(sessionId);
			if (!session) return callback(new Error('session not found or expired'));
			if (Date.now() > parseSqliteUtc(session.expiresAt)) {
				return callback(new Error('session expired'));
			}
			if (session.startedAt) {
				return callback(new Error('session already used'));
			}
			const profile = getAgentRemoteDesktop(session.agentId);
			if (!profile) return callback(new Error('agent profile gone'));
			if (!profile.host) return callback(new Error('agent remote-desktop host not configured'));

			if (tokenSettings.connection?.type !== profile.protocol) {
				return callback(new Error('protocol mismatch'));
			}

			// Re-fetch the global remoteDesktop config rather than relying on the
			// outer `settings` closure; an operator-toggled recording default
			// should take effect on the next session without a service restart.
			// `tokenSettings` is the encrypted-token payload and never carries
			// recordingEnabled, so reading it from there was always undefined.
			const liveSettings = getSetting<RemoteDesktopSettings>('remoteDesktop');
			const recording = profile.recording !== undefined
				? profile.recording
				: liveSettings?.recordingEnabled === true;
			const resolved = resolveConnectionSettings(profile, profile.host, sessionId, recording);
			const recordingPath = typeof resolved['recording-path'] === 'string' ? resolved['recording-path'] : null;
			if (!claimRemoteSessionStart(sessionId, recordingPath)) {
				return callback(new Error('session already used'));
			}
			tokenSettings.connection = { type: profile.protocol, ...resolved };
			callback(null, tokenSettings);
		} catch (e) {
			callback(e instanceof Error ? e : new Error('processConnectionSettings failed'));
		}
	};

	try {
		proxyServer = new GuacamoleLite(
			// `maxPayload: 4 MiB` caps single-message size from the browser.
			// Default upstream is 100 MiB which is enormous and lets a buggy
			// or hostile client wedge the per-connection memory. A guacamole
			// instruction is never close to 4 MiB; the cap is safety, not
			// constraint.
			{ port, host: '127.0.0.1', verifyClient, maxPayload: 4 * 1024 * 1024 },
			{ host: settings.guacdHost || '127.0.0.1', port: settings.guacdPort || 4822 },
			{
				crypt: { cypher: 'AES-256-CBC', key },
				log: { level: 'ERRORS' },
				maxInactivityTime: settings.maxSessionMinutes * 60_000,
				callbacks: { processConnectionSettings }
			}
		) as unknown as GuacLifecycleProxy;

		if (typeof proxyServer.on === 'function') {
			proxyServer.on('open', (client) => {
				try {
					const sessionId = client.connectionSettings?.itcakeSessionId;
					if (!sessionId) return;
					const session = getRemoteSession(sessionId);
					if (!session) return;
					const recordingPath = client.connectionSettings?.connection?.['recording-path'];
					recordRemoteSessionConnected(
						sessionId,
						session.userId,
						typeof recordingPath === 'string' ? recordingPath : null
					);
				} catch (e) {
					console.error('[guacamole] open handler:', e instanceof Error ? e.message : e);
				}
			});
			proxyServer.on('close', (client) => {
				try {
					const sessionId = client.connectionSettings?.itcakeSessionId;
					if (!sessionId) return;
					const session = getRemoteSession(sessionId);
					if (!session) return;
					markRemoteSessionEnded(sessionId, session.userId);
				} catch (e) {
					console.error('[guacamole] close handler:', e instanceof Error ? e.message : e);
				}
			});
		}
		console.info(`[guacamole] proxy listening on 127.0.0.1:${port}; guacd target ${settings.guacdHost}:${settings.guacdPort}`);
	} catch (e) {
		proxyServer = null;
		console.error('[guacamole] failed to start proxy:', e instanceof Error ? e.message : e);
	}
}

function stopGuacamoleProxy(): void {
	if (!proxyServer) return;
	try { if (typeof proxyServer.close === 'function') proxyServer.close(); } catch { /* best effort */ }
	proxyServer = null;
	// Remove the scoped uncaughtException swallow so subsequent unrelated
	// crashes propagate normally. The handler's own `!proxyServer` guard
	// already gates the swallow, but removing it is cleaner.
	if (guacUncaughtHandler) {
		process.off('uncaughtException', guacUncaughtHandler);
		guacUncaughtHandler = null;
	}
}

export function restartGuacamoleProxy(): void {
	stopGuacamoleProxy();
	startGuacamoleProxy();
}
