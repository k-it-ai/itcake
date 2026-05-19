import crypto from 'node:crypto';

// SHA-256 fallback is dev-only — startup-invariants + module-level
// throws in auth.ts/agent-auth.ts already refuse production boot
// without SESSION_SECRET, so the fallback path is unreachable in prod.
export function hmacOrSha256(secret: string | undefined | null, value: string | Buffer): string {
	const h = secret ? crypto.createHmac('sha256', secret) : crypto.createHash('sha256');
	return h.update(value).digest('hex');
}
