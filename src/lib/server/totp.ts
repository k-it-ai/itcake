import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from './db.js';
import { hmacOrSha256 } from './crypto-helpers.js';

// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s period). Implemented from
// stdlib so we don't pull a third-party dep for ~50 LOC of math.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;

export function base32Encode(buf: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(s: string): Buffer {
	const cleaned = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of cleaned) {
		const i = ALPHABET.indexOf(ch);
		if (i < 0) throw new Error('Invalid base32 character');
		value = (value << 5) | i;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((value >>> bits) & 0xff);
		}
	}
	return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
	return base32Encode(crypto.randomBytes(20));
}

/** Build the otpauth:// URI an authenticator app QR-encodes. */
export function totpUri(label: string, issuer: string, secret: string): string {
	const enc = encodeURIComponent;
	return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function hotp(secret: Buffer, counter: number): string {
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(counter));
	const mac = crypto.createHmac('sha1', secret).update(buf).digest();
	const offset = mac[mac.length - 1] & 0x0f;
	const code =
		((mac[offset] & 0x7f) << 24) |
		(mac[offset + 1] << 16) |
		(mac[offset + 2] << 8) |
		mac[offset + 3];
	return String(code % 1_000_000).padStart(6, '0');
}

export function totp(secret: string, time: number = Date.now()): string {
	return hotp(base32Decode(secret), Math.floor(time / 1000 / PERIOD));
}

/**
 * Verify a 6-digit code with ±1 step (≈30 s) of clock-skew tolerance.
 * Constant-time string compare prevents timing oracles on the digit count.
 */
export function totpVerify(secret: string, code: string, time: number = Date.now()): boolean {
	if (!/^\d{6}$/.test(code)) return false;
	const buf = base32Decode(secret);
	const counter = Math.floor(time / 1000 / PERIOD);
	const submitted = Buffer.from(code);
	for (const offset of [-1, 0, 1]) {
		const candidate = Buffer.from(hotp(buf, counter + offset));
		if (candidate.length === submitted.length && crypto.timingSafeEqual(candidate, submitted)) {
			return true;
		}
	}
	return false;
}

/** 10 bytes = 80 bits. Bumped from 5 (40 bits) — at the per-IP/email
 *  rate limits an online brute-force on 40 bits is bounded but defence-
 *  in-depth costs nothing. The base32 encoding produces 16 chars, which
 *  we display as two groups of 8 for readability. Existing 8-char (40-
 *  bit) codes already issued to users keep working: verification matches
 *  on the HMAC, not on length, so the upgrade is opt-in via re-init. */
const RECOVERY_CODE_BYTES = 10;
export const RECOVERY_CODE_COUNT = 10;

/**
 * Generate display-friendly recovery codes (16 base32 chars, 80 bits each).
 * Returned in plaintext exactly once — caller persists the HMACs.
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		out.push(base32Encode(crypto.randomBytes(RECOVERY_CODE_BYTES)).slice(0, 16));
	}
	return out;
}

/**
 * Hash a recovery code with HMAC-SHA256 keyed by SESSION_SECRET, so a DB
 * leak alone doesn't reveal usable codes. Falls back to plain SHA-256 in
 * dev when SESSION_SECRET isn't set.
 */
export function hashRecoveryCode(code: string): string {
	const normalized = code.toUpperCase().replace(/[^A-Z2-7]/g, '');
	return hmacOrSha256(env.SESSION_SECRET, normalized);
}

// ── MFA challenge — single-use, server-tracked ──────────────────────
//
// Stateless HMAC tokens are convenient (no per-challenge DB row at issue
// time), but a stolen-after-success token would otherwise be replayable
// inside its 5-min window: an attacker with a captured valid challenge
// + a captured TOTP code could create a second session in parallel.
// `consumeMfaChallenge` inserts the nonce hash on a successful step-2
// verify; subsequent verifies of the same token return null.
//
// The schema lives in db.ts so importing this module doesn't bring db
// init forward — totp helpers are used in pure-crypto unit tests
// without a database.
const stmtPruneMfaUsed = db.prepare('DELETE FROM mfa_used_challenges WHERE expires_at < ?');
// O_EXCL semantics via a unique-key insert: on duplicate, the row's
// presence means "already consumed" — return zero changes.
const stmtMarkMfaUsed = db.prepare(
	'INSERT OR IGNORE INTO mfa_used_challenges (nonce_hash, expires_at) VALUES (?, ?)'
);

setInterval(() => {
	try { stmtPruneMfaUsed.run(Date.now()); } catch { /* best effort */ }
}, 30 * 60 * 1000).unref();

function nonceHashHex(nonce: string): string {
	// Plain SHA-256 is fine: the nonce is already 128 bits of randomness;
	// hash collisions are computationally infeasible. We don't need HMAC
	// here because the upstream signature already bound the nonce to the
	// userId/expiresAt — by the time we look up the hash we've verified
	// the HMAC.
	return crypto.createHash('sha256').update(nonce).digest('hex');
}

/**
 * Sign a short-lived MFA challenge token (HMAC-SHA256). Issued by the
 * login endpoint when the password is correct but a TOTP code is required;
 * presented on the second request alongside the code.
 *
 * The token format is `userId.expiresAt.nonce.signature`, where the
 * signature is HMAC over the first three components. The nonce makes the
 * token single-use server-side: `verifyMfaChallenge` consumes the nonce
 * on the first successful verify so a replay returns null.
 */
export function signMfaChallenge(userId: string, ttlSeconds: number = 300): string {
	const secret = env.SESSION_SECRET;
	if (!secret) {
		throw new Error('SESSION_SECRET is required to issue MFA challenges');
	}
	const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
	const nonce = crypto.randomBytes(16).toString('hex');
	const payload = `${userId}.${expiresAt}.${nonce}`;
	const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
	return `${payload}.${sig}`;
}

interface ParsedChallengeFull {
	userId: string;
	exp: number;
	nonce: string;
}

function parseAndVerifyChallenge(token: string): ParsedChallengeFull | null {
	const secret = env.SESSION_SECRET;
	if (!secret) return null;
	const parts = token.split('.');
	if (parts.length !== 4) return null;
	const [userId, expStr, nonce, sig] = parts;
	if (!userId || !expStr || !sig) return null;
	if (!/^\d+$/.test(expStr) || !/^[0-9a-f]+$/.test(sig) || !/^[0-9a-f]+$/.test(nonce)) {
		return null;
	}

	const payload = `${userId}.${expStr}.${nonce}`;
	const expected = crypto.createHmac('sha256', secret).update(payload).digest();
	const got = Buffer.from(sig, 'hex');
	if (got.length !== expected.length || !crypto.timingSafeEqual(expected, got)) return null;

	const exp = parseInt(expStr, 10);
	const nowSec = Math.floor(Date.now() / 1000);
	if (nowSec >= exp) return null;

	const used = db
		.prepare('SELECT 1 FROM mfa_used_challenges WHERE nonce_hash = ?')
		.get(nonceHashHex(nonce));
	if (used) return null;

	return { userId, exp, nonce };
}

/**
 * Verify the challenge HMAC + expiry. Read-only: does NOT consume the
 * nonce. Callers retry the second-step (TOTP / recovery) within the
 * same token until the per-email login rate-limit kicks in (3 fails),
 * matching the prior stateless-token UX.
 *
 * The token is only consumed after a SUCCESSFUL second step via
 * `consumeMfaChallenge` — at which point any further verify of the
 * same token returns null. This prevents a stolen-after-success
 * replay while keeping legitimate operator typo-retries usable.
 */
export function verifyMfaChallenge(token: string): { userId: string } | null {
	const parsed = parseAndVerifyChallenge(token);
	return parsed ? { userId: parsed.userId } : null;
}

/**
 * Mark the challenge nonce as consumed. Returns true on first consume,
 * false on replay (already consumed) or invalid token. Callers MUST
 * call this after a successful second-step verify, before issuing the
 * session — a successful step-2 that races a duplicate request must
 * see false on the loser.
 */
export function consumeMfaChallenge(token: string): boolean {
	const parsed = parseAndVerifyChallenge(token);
	if (!parsed) return false;
	const expiresAtMs = parsed.exp * 1000;
	const result = stmtMarkMfaUsed.run(nonceHashHex(parsed.nonce), expiresAtMs);
	return result.changes === 1;
}
