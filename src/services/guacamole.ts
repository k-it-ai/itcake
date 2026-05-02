/**
 * Apache Guacamole integration. ITCake supervises a `guacamole-lite`
 * Node-side proxy that:
 *
 *   browser <—WSS—> reverse proxy (TLS term) <— ws —> ITCake guacamole-lite (127.0.0.1:proxyPort)
 *                                                          ↓ TCP
 *                                                     guacd (127.0.0.1:guacdPort)
 *                                                          ↓ RDP/VNC/SSH
 *                                                      target host (the agent)
 *
 * Token key derivation: scrypt(SESSION_SECRET, "itcake-guacamole-token-v1") → 32 bytes.
 * Both the issuer (this file) and the proxy use the same key. The same blast
 * radius applies as for other field-encrypted secrets.
 *
 * All shell-outs to the host go via `execFile` with explicit argv arrays,
 * never `exec` with string interpolation.
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { env } from '$env/dynamic/private';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — guacamole-lite ships JS without bundled types
import GuacamoleLite from 'guacamole-lite';
import { getSetting, parseSqliteUtc } from '$lib/server/db.js';
import { encryptField, decryptField, isEncryptedField } from '$lib/server/field-crypto.js';
import { DATA_DIR } from '$lib/server/data-dir.js';
import { getAgent, getAgentDataRaw } from '$services/agents.js';
import {
	createRemoteSession,
	consumeRemoteSession,
	getRemoteSession,
	markRemoteSessionStarted,
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
			maxBuffer: 4 * 1024 * 1024
		});
		return { ok: true, stdout, stderr };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, stdout: err.stdout || '', stderr: err.stderr || err.message || '' };
	}
}

// ── Per-agent profile encryption ──────────────────────────────────────
//
// Credentials are bound to the agent row via AES-GCM AAD (`enc3:` format).
// Without the binding, a DB-write attacker who can NOT read SESSION_SECRET
// could still swap one agent's encrypted password ciphertext into another
// agent's row — when the operator opens RDP to the second agent, Guacamole
// would resolve agent A's password and ship it to agent B. With AAD bound to
// `agent.remoteDesktop:<id>`, the moved ciphertext fails GCM tag verification
// at its destination row and decryption refuses.
//
// Legacy v2 ciphertexts continue to read (decryptField ignores AAD on v2);
// the next set-profile write upgrades to v3 automatically.

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

// ── Guacamole-lite token (browser-bound) ──────────────────────────────

const TOKEN_KEY_INFO = 'itcake-guacamole-token-v1';
const TOKEN_KEY_BYTES = 32;

let cachedTokenKey: Buffer | null | undefined;

function tokenKey(): Buffer | null {
	if (cachedTokenKey !== undefined) return cachedTokenKey;
	const secret = env.SESSION_SECRET;
	if (!secret) { cachedTokenKey = null; return null; }
	cachedTokenKey = crypto.scryptSync(secret, TOKEN_KEY_INFO, TOKEN_KEY_BYTES);
	return cachedTokenKey;
}

/**
 * Encrypted-token payload. Note what is **deliberately absent**:
 * `connection.settings` is empty when the token is minted. Hostname,
 * port, username, password, ignore-cert, recording-path — all the
 * sensitive connection details — are resolved server-side at WS-open
 * time via `processConnectionSettings` (see `startGuacamoleProxy`).
 *
 * `connection.type` MUST be present because guacamole-lite reads it
 * BEFORE the callback runs to pick the protocol-specific defaults
 * (`mergeConnectionOptions` in node_modules/guacamole-lite/lib/ClientConnection.js).
 * We tolerate that exposure: a bit-flipped `type` only causes a
 * protocol/settings mismatch at guacd, not data loss.
 */
interface GuacTokenPayload {
	connection: { type: RemoteDesktopProtocol; settings: Record<string, never> };
	itcakeSessionId: string;
}

/**
 * Resolve the flat connection settings dict for guacd from an agent
 * profile + runtime context. Callers: the server-side
 * `processConnectionSettings` callback only — credentials never travel
 * inside the encrypted token (see `GuacTokenPayload` doc).
 *
 * Returned shape matches guacamole-lite's post-merge `connection`
 * object (flat dict, no nested `.settings`).
 */
function resolveConnectionSettings(
	profile: AgentRemoteDesktop,
	ip: string,
	sessionId: string,
	recording: boolean
): Record<string, string | number | boolean | undefined> {
	const settings: Record<string, string | number | boolean | undefined> = {
		hostname: ip,
		port: profile.port,
		username: profile.username || undefined,
		password: profile.password || undefined
	};

	if (profile.protocol === 'rdp') {
		// Prefer TLS with cert verification by default. The previous
		// default (`security: 'any'` + ignore-cert: true) silently
		// accepted any RDP cert and any negotiation downgrade — a
		// network attacker between the ITCake host and the agent could
		// MITM Administrator credentials with no warning. Operators on
		// hosts with truly self-signed RDP can opt in via the per-agent
		// `ignoreCert: true` flag (recorded in the audit log when set)
		// — but they must do so explicitly per agent.
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
		fs.mkdirSync(dir, { recursive: true });
		settings['recording-path'] = dir;
		settings['recording-name'] = 'session.guac';
		settings['create-recording-path'] = true;
	}
	return settings;
}

/**
 * The encrypted token format is dictated by guacamole-lite (`{iv,value}`
 * base64-of-JSON, AES-256-CBC). CBC has no MAC, so a network attacker
 * who could see and modify the ciphertext could in principle flip bits.
 *
 * To make malleability practically inert, the token carries **only**
 * `{ connection: { type }, itcakeSessionId }` — no hostname, port,
 * username, password, recording path. Hostname/credentials are
 * resolved server-side at WS-open time by `processConnectionSettings`
 * (see `startGuacamoleProxy`), keyed on the already-validated
 * `itcakeSessionId` (UUID, looked up against `remote_sessions`).
 *
 * What an attacker who flips ciphertext bits gets:
 *   - JSON.parse failure inside guacamole-lite (overwhelming majority).
 *   - JSON-valid garbage with a sessionId not in the DB → callback
 *     refuses the connection (`session not found`).
 *   - JSON-valid garbage with a different `connection.type` → guacd
 *     rejects mismatched protocol/settings.
 *
 * No credential leak, no host redirection, no replay surface.
 * Layered with WSS-only transport, WS Origin verification on upgrade,
 * single-use `consumeRemoteSession`, and short (≤ 5 min) TTLs.
 */
function encryptGuacToken(payload: GuacTokenPayload): string {
	const key = tokenKey();
	if (!key) throw new Error('SESSION_SECRET unset; cannot mint Guacamole token');
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64');
	const wrapped = JSON.stringify({ iv: iv.toString('base64'), value: ciphertext });
	return Buffer.from(wrapped, 'utf8').toString('base64');
}

// ── Public issuance API ───────────────────────────────────────────────

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

	// Pre-flight checks so the browser fails fast (404) instead of seeing
	// an opaque guacd error mid-handshake. The actual credentials are
	// re-resolved at WS-open time by `processConnectionSettings`.
	const profile = getAgentRemoteDesktop(session.agentId);
	if (!profile) return null;
	const agent = getAgent(session.agentId);
	if (!agent || !agent.ip) return null;

	const guacToken = encryptGuacToken({
		connection: { type: profile.protocol, settings: {} },
		itcakeSessionId: session.id
	});

	return { guacToken, sessionId: session.id, maxSessionMinutes: settings.maxSessionMinutes };
}

// ── guacd availability + install/update ──────────────────────────────

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
	const which = await runArgv('which', ['guacd'], 5_000);
	if (which.ok && which.stdout.trim()) {
		installed = true;
		const ver = await runArgv('guacd', ['-v'], 5_000);
		const probe = (ver.stdout + '\n' + ver.stderr).match(/version ([\d.]+)/i);
		if (probe) version = probe[1];
	}
	const reachable = installed ? await probeGuacd(host, port) : false;
	return { installed, version, reachable, host, port };
}

interface PmRoute {
	mgr: string;
	install: { file: string; args: string[] }[];   // sequence of execFile invocations
	update: { file: string; args: string[] }[];
}

function detectPackageManager(): PmRoute | null {
	if (process.platform === 'darwin') {
		return {
			mgr: 'brew',
			install: [{ file: 'brew', args: ['install', 'guacamole-server'] }],
			update: [{ file: 'brew', args: ['upgrade', 'guacamole-server'] }]
		};
	}
	if (process.platform === 'linux') {
		const candidates: PmRoute[] = [
			{
				mgr: 'apt-get',
				install: [
					{ file: 'sudo', args: ['-n', 'apt-get', 'update', '-qq'] },
					{ file: 'sudo', args: ['-n', 'apt-get', 'install', '-y', 'guacd'] }
				],
				update: [
					{ file: 'sudo', args: ['-n', 'apt-get', 'update', '-qq'] },
					{ file: 'sudo', args: ['-n', 'apt-get', 'install', '-y', '--only-upgrade', 'guacd'] }
				]
			},
			{
				mgr: 'dnf',
				install: [{ file: 'sudo', args: ['-n', 'dnf', 'install', '-y', 'guacd'] }],
				update: [{ file: 'sudo', args: ['-n', 'dnf', 'upgrade', '-y', 'guacd'] }]
			},
			{
				mgr: 'pacman',
				install: [{ file: 'sudo', args: ['-n', 'pacman', '-S', '--noconfirm', 'guacd'] }],
				update: [{ file: 'sudo', args: ['-n', 'pacman', '-Syu', '--noconfirm', 'guacd'] }]
			},
			{
				mgr: 'apk',
				install: [{ file: 'sudo', args: ['-n', 'apk', 'add', '--no-cache', 'guacamole-server'] }],
				update: [{ file: 'sudo', args: ['-n', 'apk', 'upgrade', '--no-cache', 'guacamole-server'] }]
			}
		];
		for (const route of candidates) {
			// Check whether the package manager binary exists.
			try {
				const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
				execFileSync('which', [route.mgr], { stdio: 'ignore', timeout: 2000 });
				return route;
			} catch { /* keep trying */ }
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

// ── guacenc (recording → MP4) ─────────────────────────────────────────

/**
 * Resolve a session recording to a playable MP4 — lazily transcoding the
 * raw `.guac` wire-protocol dump on first access. After a successful
 * conversion the source `.guac` is unlinked, so a recording lives on
 * disk in exactly one format (the playable one). Idempotent: calling
 * again after conversion returns the cached MP4 immediately.
 *
 * sessionId is generated server-side (UUID-ish), so it's shell-safe
 * when interpolated — but we still go through execFile with an
 * explicit argv to keep the convention consistent.
 */
export async function convertRecording(sessionId: string): Promise<{ ok: boolean; mp4Path: string | null; error?: string }> {
	if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
		return { ok: false, mp4Path: null, error: 'invalid session id' };
	}
	const dir = path.join(DATA_DIR, 'recordings', sessionId);
	const guacFile = path.join(dir, 'session.guac');
	const mp4Path = guacFile + '.m4v';
	// Cached path: previous conversion already produced (and verified)
	// the MP4. Source .guac was unlinked at that point.
	if (fs.existsSync(mp4Path)) return { ok: true, mp4Path };
	if (!fs.existsSync(guacFile)) return { ok: false, mp4Path: null, error: 'recording not found' };
	const r = await runArgv('guacenc', ['-s', '1280x800', '-r', '4000000', '-f', guacFile], 600_000);
	if (!r.ok || !fs.existsSync(mp4Path)) {
		return { ok: false, mp4Path: null, error: r.stderr || 'guacenc failed' };
	}
	// Source .guac is no longer needed — we have the playable artifact
	// and keeping both doubles disk pressure. Unlink failures are
	// non-fatal: the MP4 is still serviceable, we just leave the .guac
	// behind for the operator to clean up.
	try { fs.unlinkSync(guacFile); } catch (e) {
		console.warn('[guacamole] post-conversion unlink failed for', guacFile, ':', e instanceof Error ? e.message : e);
	}
	return { ok: true, mp4Path };
}

// ── guacamole-lite proxy lifecycle ────────────────────────────────────

interface GuacLifecycleProxy {
	close?: () => void;
	on?: (event: string, cb: (client: GuacClientConnection) => void) => void;
}

/**
 * Post-merge shape guacamole-lite hands to event listeners. `connection`
 * here is the FLAT settings dict (`hostname`, `port`, `recording-path`,
 * etc.) — the original nested `.settings` from the encrypted token has
 * already been merged into this dict by `mergeConnectionOptions` in
 * node_modules/guacamole-lite/lib/ClientConnection.js.
 */
interface MergedConnectionSettings {
	itcakeSessionId?: string;
	connection?: { type?: string; [key: string]: unknown };
	[key: string]: unknown;
}

interface GuacClientConnection {
	connectionSettings?: MergedConnectionSettings;
}

let proxyServer: GuacLifecycleProxy | null = null;
let guacUncaughtHandlerInstalled = false;

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
	// CSRF parity with REST: reject WebSocket upgrades whose Origin does not
	// match the configured ORIGIN env. Without this, the proxy accepts any
	// cross-origin upgrade and a stolen Guac token can be replayed from a
	// hostile page (the upgrade itself never hits SvelteKit's hooks where
	// validateOrigin() runs). Mirrors the request-level check in
	// hooks.server.ts:114 — same rule.
	//
	// Normalise both sides via `new URL().origin` so scheme casing, default
	// ports (80/443), and trailing slashes match the way browsers compute
	// `Origin`. Bare-string compare missed `https://itcake:443` vs
	// `https://itcake`, and missed mixed-case schemes.
	let expectedOriginNorm = '';
	try { if (env.ORIGIN) expectedOriginNorm = new URL(env.ORIGIN).origin; } catch { /* malformed */ }
	const verifyClient = (info: { origin?: string; req: { headers: Record<string, string | string[] | undefined> } }) => {
		const raw = info.origin || '';
		// `Origin: null` (literal string) for sandboxed iframes and `file://`
		// is rejected outright.
		if (!raw || raw === 'null') return false;
		let originNorm: string;
		try { originNorm = new URL(raw).origin; } catch { return false; }
		if (!expectedOriginNorm) {
			if (env.NODE_ENV === 'production') return false;
			// Dev fallback: only loopback hosts (proxy already binds 127.0.0.1).
			// Use URL parsing so attacker host like `localhost.evil.com` is
			// rejected (the previous startsWith check accepted it).
			let parsed: URL;
			try { parsed = new URL(raw); } catch { return false; }
			return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
		}
		return originNorm === expectedOriginNorm;
	};

	// guacamole-lite has a known crash path on malformed/expired tokens
	// (TypeError: Cannot read properties of undefined (reading 'connection')
	// in ClientConnection.connect). Until upstream patches, we install a
	// process-level uncaughtException handler that recognises this specific
	// error pattern and continues; other uncaught errors are re-thrown so we
	// don't mask real bugs.
	if (!guacUncaughtHandlerInstalled) {
		process.on('uncaughtException', (err) => {
			const msg = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? (err.stack || '') : '';
			if (
				/Cannot read propert(y|ies) of undefined \(reading 'connection'\)/.test(msg) &&
				/guacamole-lite\/lib\/ClientConnection/.test(stack)
			) {
				console.error('[guacamole] swallowed known guacamole-lite crash on bad token:', msg);
				return;
			}
			// Re-throw anything else so Node's default handler runs.
			throw err;
		});
		guacUncaughtHandlerInstalled = true;
	}

	// Server-side resolution of connection details. The encrypted token
	// carries only `{ connection: { type }, itcakeSessionId }` — no
	// hostname / port / username / password / recording-path. We
	// resolve those here from the agent profile, keyed on the
	// already-validated session id.
	//
	// `settings` is the post-merge object from guacamole-lite. We mutate
	// `settings.connection` (the flat dict guacd will receive) in place
	// and call back with the same reference; the lib then assigns it
	// onto the client connection.
	const processConnectionSettings = (
		settings: MergedConnectionSettings,
		callback: (err: Error | null, settings?: MergedConnectionSettings) => void
	): void => {
		try {
			const sessionId = settings.itcakeSessionId;
			if (typeof sessionId !== 'string' || !sessionId) {
				return callback(new Error('missing itcakeSessionId'));
			}
			const session = getRemoteSession(sessionId);
			if (!session) return callback(new Error('session not found or expired'));
			if (Date.now() > parseSqliteUtc(session.expiresAt)) {
				return callback(new Error('session expired'));
			}
			const profile = getAgentRemoteDesktop(session.agentId);
			if (!profile) return callback(new Error('agent profile gone'));
			const agent = getAgent(session.agentId);
			if (!agent || !agent.ip) return callback(new Error('agent unreachable'));

			// Refuse a token whose declared protocol disagrees with the
			// agent's actual profile — a bit-flipped `connection.type`
			// would otherwise reach guacd as the wrong protocol.
			if (settings.connection?.type !== profile.protocol) {
				return callback(new Error('protocol mismatch'));
			}

			const recording = profile.recording !== undefined ? profile.recording : settings.recordingEnabled === true;
			const resolved = resolveConnectionSettings(profile, agent.ip, sessionId, recording);
			settings.connection = { type: profile.protocol, ...resolved };
			callback(null, settings);
		} catch (e) {
			callback(e instanceof Error ? e : new Error('processConnectionSettings failed'));
		}
	};

	try {
		proxyServer = new GuacamoleLite(
			{ port, host: '127.0.0.1', verifyClient },
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
					// Post-merge `connection` is the flat dict guacd receives,
					// so `recording-path` lives directly on it (NOT under a
					// nested `.settings`).
					const recordingPath = client.connectionSettings?.connection?.['recording-path'];
					markRemoteSessionStarted(
						sessionId,
						typeof recordingPath === 'string' ? recordingPath : null,
						session.userId
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
}

export function restartGuacamoleProxy(): void {
	stopGuacamoleProxy();
	startGuacamoleProxy();
}
