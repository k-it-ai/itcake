/**
 * Startup invariants enforced before any request is served.
 *
 * Each check throws on misconfiguration rather than logging-and-continuing.
 * A production deploy that survives a missing security boundary is worse
 * than one that refuses to start: the first looks healthy until it's
 * exploited, the second wakes the operator at deploy time.
 */
import fs from 'node:fs';
import path from 'node:path';

type StartupEnv = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const KNOWN_NODE_ENVS = new Set(['development', 'test', 'production']);

export function assertProductionInvariants(env: StartupEnv): void {
	if (env.NODE_ENV !== undefined && !KNOWN_NODE_ENVS.has(env.NODE_ENV)) {
		throw new Error(`[startup] FATAL: NODE_ENV="${env.NODE_ENV}" is not recognised. Use one of: development, test, production.`);
	}

	if (env.PORT !== undefined && env.PORT !== '') {
		const port = Number(env.PORT);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`[startup] FATAL: PORT="${env.PORT}" is invalid (must be an integer between 1 and 65535).`);
		}
	}

	if (env.NODE_ENV !== 'production') {
		if (env.HOST && !LOOPBACK_HOSTS.has(env.HOST) && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
			console.warn(
				`[startup] WARNING: HOST=${env.HOST} (non-loopback) but NODE_ENV is unset. ` +
				'Cookies will be marked non-secure, SESSION_SECRET is not enforced, ' +
				'and CSRF Origin checks have no canonical URL. ' +
				'Set NODE_ENV=production for any deployment reachable beyond localhost.'
			);
		}
		return;
	}

	if (!env.ORIGIN) {
		throw new Error('[startup] FATAL: ORIGIN is required in production for CSRF protection. Set ORIGIN to your public URL (e.g. https://itcake.example.com) in .env and restart.');
	}

	if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
		throw new Error('[startup] FATAL: SESSION_SECRET is required in production and must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" and add it to your .env file.');
	}

	if (env.ADDRESS_HEADER && env.HOST && !LOOPBACK_HOSTS.has(env.HOST) && env.TRUST_PROXY !== 'true') {
		throw new Error(`[startup] FATAL: ADDRESS_HEADER is set but HOST=${env.HOST}. Bind to 127.0.0.1 when ADDRESS_HEADER is in use, or set TRUST_PROXY=true to acknowledge that only a reverse proxy can reach this port (correct for container deployments where the container network IS the trust boundary). Otherwise direct connections can spoof the client IP and bypass rate limiting.`);
	}

	// PUPPETEER_NO_SANDBOX=true bypasses Chromium's renderer sandbox. The
	// PDF templates load operator-controlled content; an unsandboxed
	// Chromium with a parser bug = renderer RCE on the host. Refuse in
	// production unconditionally — the operator should run Puppeteer with
	// its built-in sandbox, or as a non-root user with the right kernel
	// capabilities, NOT with NO_SANDBOX.
	if (env.PUPPETEER_NO_SANDBOX === 'true') {
		throw new Error(
			'[startup] FATAL: PUPPETEER_NO_SANDBOX=true bypasses Chromium\'s renderer sandbox. ' +
			'A PDF template parser bug becomes host-level RCE in this mode. Unset PUPPETEER_NO_SANDBOX and run Puppeteer with its sandbox enabled (the default).'
		);
	}

	// DATA_DIR writability probe. A typo, wrong owner, or read-only mount
	// causes SQLite startup to throw a non-obvious error deep inside
	// `Database` constructor. Pre-flight check gives a clearer failure.
	const dataDir = env.DATA_DIR || 'data';
	try {
		const resolved = path.resolve(dataDir);
		if (!fs.existsSync(resolved)) {
			fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
		}
		fs.accessSync(resolved, fs.constants.W_OK);
	} catch (e) {
		throw new Error(
			`[startup] FATAL: DATA_DIR="${dataDir}" is not writable (${e instanceof Error ? e.message : String(e)}). The DB, uploads, backups, and agent binaries all live here. Set DATA_DIR to a writable directory or fix the permissions.`
		);
	}
}
