import crypto from 'node:crypto';

// SHA-256 fallback is dev-only — production boot refuses missing SESSION_SECRET.
export function hmacOrSha256(secret: string | undefined | null, value: string | Buffer): string {
	const h = secret ? crypto.createHmac('sha256', secret) : crypto.createHash('sha256');
	return h.update(value).digest('hex');
}
