import fs from 'node:fs';
import path from 'node:path';
import { parseOrigin } from './origin.js';

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

	let parsedOrigin: ReturnType<typeof parseOrigin>;
	try {
		parsedOrigin = parseOrigin(env.ORIGIN);
	} catch (e) {
		throw new Error(`[startup] FATAL: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (parsedOrigin.protocol === 'http:' && !parsedOrigin.isLoopback) {
		throw new Error(
			'[startup] FATAL: ORIGIN uses http:// but the host is not loopback. ' +
			'Production requires HTTPS; terminate TLS in a reverse proxy and set ORIGIN to the https:// URL. ' +
			'Plain http:// is allowed only for localhost/127.0.0.1 smoke tests.'
		);
	}

	if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
		throw new Error('[startup] FATAL: SESSION_SECRET is required in production and must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" and add it to your .env file.');
	}

	// adapter-node defaults HOST to 0.0.0.0. Treat an unset HOST as that default:
	// otherwise ADDRESS_HEADER would be trusted on a directly reachable port and
	// clients could spoof X-Forwarded-For to bypass IP rate limiting.
	const effectiveHost = env.HOST || '0.0.0.0';
	if (env.ADDRESS_HEADER && !LOOPBACK_HOSTS.has(effectiveHost) && env.TRUST_PROXY !== 'true') {
		throw new Error(`[startup] FATAL: ADDRESS_HEADER is set but HOST=${env.HOST || '(unset, defaults to 0.0.0.0)'}. Bind to 127.0.0.1 when ADDRESS_HEADER is in use, or set TRUST_PROXY=true to acknowledge that only a reverse proxy can reach this port (correct for container deployments where the container network IS the trust boundary). Otherwise direct connections can spoof the client IP and bypass rate limiting.`);
	}

	if (env.PUPPETEER_NO_SANDBOX === 'true') {
		throw new Error(
			'[startup] FATAL: PUPPETEER_NO_SANDBOX=true bypasses Chromium\'s renderer sandbox. ' +
			'A PDF template parser bug becomes host-level RCE in this mode. Unset PUPPETEER_NO_SANDBOX and run Puppeteer with its sandbox enabled (the default).'
		);
	}

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
