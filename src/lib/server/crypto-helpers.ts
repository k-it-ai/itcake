import crypto from 'node:crypto';

/**
 * Hash a value with HMAC-SHA256 keyed by `secret`, falling back to plain
 * SHA-256 when `secret` is empty. The fallback exists for dev environments
 * where `SESSION_SECRET` isn't configured yet — production callers MUST
 * have already refused to start (see startup-invariants.ts and the module-
 * level throws in auth.ts / agent-auth.ts) so the SHA-256 path is never
 * reached on a real deployment.
 *
 * Consolidates the three byte-equivalent helpers that previously lived in
 * auth.ts (hashSessionToken), agent-auth.ts (hashAgentToken) and totp.ts
 * (hashRecoveryCode). changes.ts keeps its own variant because it
 * additionally throws in production when the secret is missing.
 */
export function hmacOrSha256(secret: string | undefined | null, value: string | Buffer): string {
	const h = secret ? crypto.createHmac('sha256', secret) : crypto.createHash('sha256');
	return h.update(value).digest('hex');
}

/**
 * Constant-time equality for two Buffers. Returns false on length mismatch
 * (timingSafeEqual itself throws on mismatched lengths — guarding here keeps
 * the comparison oracle-free for callers iterating heterogeneous rows).
 */
export function safeBufEqual(a: Buffer, b: Buffer): boolean {
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}
