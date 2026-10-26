const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface ParsedOrigin {
	/** Canonical scheme://host[:port] form, without a trailing slash. */
	origin: string;
	protocol: 'http:' | 'https:';
	hostname: string;
	isLoopback: boolean;
}

/**
 * Parse and validate an ORIGIN value.
 *
 * ORIGIN is an origin, not a URL: paths, queries, fragments, credentials and
 * trailing slashes are rejected so that comparison against the browser's
 * Origin header is exact. SvelteKit 3 removed adapter-node's runtime ORIGIN
 * handling, so install.sh and the adapter wrapper both depend on this shape.
 */
export function parseOrigin(raw: string): ParsedOrigin {
	const value = raw.trim();
	if (!value) {
		throw new Error('ORIGIN is empty. Set it to your public URL (e.g. https://invoices.example.com).');
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(
			'ORIGIN must be an absolute URL, e.g. https://invoices.example.com (or http://127.0.0.1:3000 for local testing).'
		);
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`ORIGIN must use http:// or https://, not ${url.protocol}`);
	}
	if (url.username || url.password) {
		throw new Error('ORIGIN must not contain a username or password.');
	}
	if (url.search || url.hash) {
		throw new Error('ORIGIN must not contain a query string or fragment.');
	}
	if (value.endsWith('/')) {
		throw new Error(`ORIGIN must not end with a trailing slash. Use ${url.origin} instead.`);
	}
	if (url.pathname !== '/') {
		throw new Error(`ORIGIN must be an origin only, without a path. Use ${url.origin} instead.`);
	}

	return {
		origin: url.origin,
		protocol: url.protocol,
		hostname: url.hostname,
		isLoopback: LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())
	};
}

/**
 * Session cookies are Secure on HTTPS. Production over plain HTTP is only
 * supported for loopback installs (local smoke tests); startup-invariants
 * rejects non-loopback http:// ORIGIN values.
 */
export function isSecureSessionCookie(origin: string | undefined, nodeEnv: string | undefined): boolean {
	if (origin) {
		try {
			return parseOrigin(origin).protocol === 'https:';
		} catch {
			// Production startup already rejects malformed ORIGIN. In development
			// an invalid value must not turn login into a 500; fall back to the
			// NODE_ENV policy below.
		}
	}
	return nodeEnv === 'production';
}
