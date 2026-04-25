import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';

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

const RECOVERY_CODE_BYTES = 5;
export const RECOVERY_CODE_COUNT = 10;

/**
 * Generate display-friendly recovery codes (8 base32 chars, 40 bits each).
 * Returned in plaintext exactly once — caller persists the HMACs.
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		out.push(base32Encode(crypto.randomBytes(RECOVERY_CODE_BYTES)).slice(0, 8));
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
	const secret = env.SESSION_SECRET;
	if (secret) {
		return crypto.createHmac('sha256', secret).update(normalized).digest('hex');
	}
	return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Sign a short-lived MFA challenge token (HMAC-SHA256). Issued by the
 * login endpoint when the password is correct but a TOTP code is required;
 * presented on the second request alongside the code. Stateless — no DB.
 */
export function signMfaChallenge(userId: string, ttlSeconds: number = 300): string {
	const secret = env.SESSION_SECRET;
	if (!secret) {
		throw new Error('SESSION_SECRET is required to issue MFA challenges');
	}
	const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
	const payload = `${userId}.${expiresAt}`;
	const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
	return `${payload}.${sig}`;
}

export function verifyMfaChallenge(token: string): { userId: string } | null {
	const secret = env.SESSION_SECRET;
	if (!secret) return null;
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [userId, expStr, sig] = parts;
	if (!userId || !/^\d+$/.test(expStr) || !/^[0-9a-f]+$/.test(sig)) return null;

	const expected = crypto.createHmac('sha256', secret).update(`${userId}.${expStr}`).digest();
	const got = Buffer.from(sig, 'hex');
	if (got.length !== expected.length || !crypto.timingSafeEqual(expected, got)) return null;

	const exp = parseInt(expStr, 10);
	if (Math.floor(Date.now() / 1000) >= exp) return null;
	return { userId };
}
