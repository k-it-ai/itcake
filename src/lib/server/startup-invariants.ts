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

/**
 * Set of recognised NODE_ENV values. Anything outside this set is rejected
 * at startup so a typo (`staging`, `prod`, `prdouction`) doesn't silently
 * disable production-only invariants — the audit-chain SHA-256 fallback
 * and the production CSRF check both gate on `NODE_ENV === 'production'`.
 */
const KNOWN_NODE_ENVS = new Set(['development', 'test', 'production']);

export function assertProductionInvariants(env: StartupEnv): void {
	if (env.NODE_ENV !== undefined && !KNOWN_NODE_ENVS.has(env.NODE_ENV)) {
		throw new Error(`[startup] FATAL: NODE_ENV="${env.NODE_ENV}" is not recognised. Use one of: development, test, production.`);
	}

	if (env.NODE_ENV !== 'production') return;

	if (!env.ORIGIN) {
		// Without ORIGIN, SvelteKit derives the origin from whatever Host
		// header the first request carries. A request reaching the app
		// over HTTP or with a spoofed Host then defines the trusted
		// origin for the lifetime of the process; future cross-origin
		// requests are compared against that wrong reference and the
		// CSRF defence collapses silently.
		throw new Error('[startup] FATAL: ORIGIN is required in production for CSRF protection. Set ORIGIN to your public URL (e.g. https://itcake.example.com) in .env and restart.');
	}

	if (env.ADDRESS_HEADER && env.HOST && !LOOPBACK_HOSTS.has(env.HOST)) {
		// Combined with a publicly-reachable bind, a trusted
		// X-Forwarded-For lets a direct connection spoof the client IP
		// and bypass per-IP login rate-limiting.
		throw new Error(`[startup] FATAL: ADDRESS_HEADER is set but HOST=${env.HOST}. Bind to 127.0.0.1 only when ADDRESS_HEADER is in use; otherwise direct connections can spoof the client IP and bypass rate limiting.`);
	}
}
