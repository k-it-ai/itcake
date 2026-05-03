import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from './db.js';
import { hmacOrSha256 } from './crypto-helpers.js';

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

const RECOVERY_CODE_BYTES = 10;
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		out.push(base32Encode(crypto.randomBytes(RECOVERY_CODE_BYTES)).slice(0, 16));
	}
	return out;
}

export function hashRecoveryCode(code: string): string {
	const normalized = code.toUpperCase().replace(/[^A-Z2-7]/g, '');
	return hmacOrSha256(env.SESSION_SECRET, normalized);
}

const stmtPruneMfaUsed = db.prepare('DELETE FROM mfa_used_challenges WHERE expires_at < ?');
const stmtMarkMfaUsed = db.prepare(
	'INSERT OR IGNORE INTO mfa_used_challenges (nonce_hash, expires_at) VALUES (?, ?)'
);

setInterval(() => {
	try { stmtPruneMfaUsed.run(Date.now()); } catch { /* best effort */ }
}, 30 * 60 * 1000).unref();

function nonceHashHex(nonce: string): string {
	return hmacOrSha256(env.SESSION_SECRET, nonce);
}

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

export function verifyMfaChallenge(token: string): { userId: string } | null {
	const parsed = parseAndVerifyChallenge(token);
	return parsed ? { userId: parsed.userId } : null;
}

export function consumeMfaChallenge(token: string): boolean {
	const parsed = parseAndVerifyChallenge(token);
	if (!parsed) return false;
	const expiresAtMs = parsed.exp * 1000;
	const result = stmtMarkMfaUsed.run(nonceHashHex(parsed.nonce), expiresAtMs);
	return result.changes === 1;
}
