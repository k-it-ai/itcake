/**
 * Startup invariants enforced before any request is served.
 *
 * Each check throws on misconfiguration rather than logging-and-continuing.
 * A production deploy that survives a missing security boundary is worse
 * than one that refuses to start: the first looks healthy until it's
 * exploited, the second wakes the operator at deploy time.
 */
type StartupEnv = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const KNOWN_NODE_ENVS = new Set(['development', 'test', 'production']);

export function assertProductionInvariants(env: StartupEnv): void {
	if (env.NODE_ENV !== undefined && !KNOWN_NODE_ENVS.has(env.NODE_ENV)) {
		throw new Error(`[startup] FATAL: NODE_ENV="${env.NODE_ENV}" is not recognised. Use one of: development, test, production.`);
	}

	if (env.NODE_ENV !== 'production') return;

	if (!env.ORIGIN) {
		throw new Error('[startup] FATAL: ORIGIN is required in production for CSRF protection. Set ORIGIN to your public URL (e.g. https://itcake.example.com) in .env and restart.');
	}

	if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
		throw new Error('[startup] FATAL: SESSION_SECRET is required in production and must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" and add it to your .env file.');
	}

	if (env.ADDRESS_HEADER && env.HOST && !LOOPBACK_HOSTS.has(env.HOST) && env.TRUST_PROXY !== 'true') {
		throw new Error(`[startup] FATAL: ADDRESS_HEADER is set but HOST=${env.HOST}. Bind to 127.0.0.1 when ADDRESS_HEADER is in use, or set TRUST_PROXY=true to acknowledge that only a reverse proxy can reach this port (correct for container deployments where the container network IS the trust boundary). Otherwise direct connections can spoof the client IP and bypass rate limiting.`);
	}
}
