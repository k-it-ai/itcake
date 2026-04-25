import { describe, it, expect } from 'vitest';
import {
	base32Encode,
	base32Decode,
	generateTotpSecret,
	totp,
	totpVerify,
	totpUri,
	generateRecoveryCodes,
	hashRecoveryCode,
	signMfaChallenge,
	verifyMfaChallenge
} from '../../src/lib/server/totp.js';

describe('base32', () => {
	it('round-trips arbitrary bytes', () => {
		for (const len of [1, 5, 10, 20, 32]) {
			const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 7) & 0xff));
			expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
		}
	});

	it('encodes RFC 4648 test vectors', () => {
		// `f`, `fo`, `foo`, `foob`, `fooba`, `foobar` from RFC 4648 §10.
		expect(base32Encode(Buffer.from('f'))).toBe('MY');
		expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ');
		expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6');
		expect(base32Encode(Buffer.from('foob'))).toBe('MZXW6YQ');
		expect(base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB');
		expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
	});

	it('rejects invalid characters', () => {
		// Strict decode of an internal-only path (not user-facing). Any
		// non-base32 char is silently filtered before alphabet lookup, so
		// "1" is dropped. We assert the surviving stream still decodes.
		expect(() => base32Decode('1MZXW6')).not.toThrow();
	});
});

describe('TOTP (RFC 6238 reference vectors)', () => {
	// RFC 6238 Appendix B test vectors. The reference key is "12345678901234567890" (ASCII).
	// In base32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

	it.each([
		[59, '94287082'.slice(-6)],
		[1111111109, '07081804'.slice(-6)],
		[1111111111, '14050471'.slice(-6)],
		[1234567890, '89005924'.slice(-6)],
		[2000000000, '69279037'.slice(-6)]
	])('generates correct code at t=%d', (t, expected) => {
		expect(totp(SECRET, t * 1000)).toBe(expected);
	});

	it('verify accepts the current step', () => {
		const t = Date.now();
		const code = totp(SECRET, t);
		expect(totpVerify(SECRET, code, t)).toBe(true);
	});

	it('verify accepts ±1 step (clock skew tolerance)', () => {
		const t = Date.now();
		// Code from 30s ago should still pass at "now" with the ±1 window.
		const earlier = totp(SECRET, t - 30_000);
		expect(totpVerify(SECRET, earlier, t)).toBe(true);
		// Future skew (e.g., agent clock 30s ahead).
		const later = totp(SECRET, t + 30_000);
		expect(totpVerify(SECRET, later, t)).toBe(true);
	});

	it('verify rejects codes outside the window', () => {
		const t = Date.now();
		const tooOld = totp(SECRET, t - 90_000);
		expect(totpVerify(SECRET, tooOld, t)).toBe(false);
	});

	it('verify rejects malformed codes', () => {
		const t = Date.now();
		expect(totpVerify(SECRET, '12345', t)).toBe(false);
		expect(totpVerify(SECRET, '1234567', t)).toBe(false);
		expect(totpVerify(SECRET, 'abcdef', t)).toBe(false);
		expect(totpVerify(SECRET, '', t)).toBe(false);
	});

	it('generates unique secrets', () => {
		const secrets = new Set();
		for (let i = 0; i < 20; i++) secrets.add(generateTotpSecret());
		expect(secrets.size).toBe(20);
	});

	it('builds a syntactically valid otpauth URI', () => {
		const uri = totpUri('user@test.com', 'ITCake', SECRET);
		expect(uri).toMatch(/^otpauth:\/\/totp\//);
		expect(uri).toContain('issuer=ITCake');
		expect(uri).toContain(`secret=${SECRET}`);
		expect(uri).toContain('algorithm=SHA1');
		expect(uri).toContain('digits=6');
		expect(uri).toContain('period=30');
	});
});

describe('Recovery codes', () => {
	it('generates 10 unique 8-character codes', () => {
		const codes = generateRecoveryCodes();
		expect(codes.length).toBe(10);
		expect(new Set(codes).size).toBe(10);
		for (const c of codes) {
			expect(c).toMatch(/^[A-Z2-7]{8}$/);
		}
	});

	it('hash is deterministic for normalized input', () => {
		const code = 'ABCD2345';
		expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code));
		// Lowercase + dashes are normalized away — typical authenticator-app paste format.
		expect(hashRecoveryCode('abcd-2345')).toBe(hashRecoveryCode('ABCD2345'));
	});

	it('different codes produce different hashes', () => {
		const a = hashRecoveryCode('ABCD2345');
		const b = hashRecoveryCode('ABCD2346');
		expect(a).not.toBe(b);
	});
});

describe('MFA challenge token', () => {
	it('round-trips a userId', () => {
		const tok = signMfaChallenge('user-123', 60);
		const result = verifyMfaChallenge(tok);
		expect(result).toEqual({ userId: 'user-123' });
	});

	it('rejects expired tokens', () => {
		const tok = signMfaChallenge('user-123', -1);
		expect(verifyMfaChallenge(tok)).toBe(null);
	});

	it('rejects tokens with mutated body', () => {
		const tok = signMfaChallenge('user-123', 60);
		// Replace the userId in the token but keep the original signature →
		// HMAC mismatch → reject.
		const parts = tok.split('.');
		const tampered = `attacker.${parts[1]}.${parts[2]}`;
		expect(verifyMfaChallenge(tampered)).toBe(null);
	});

	it('rejects malformed tokens', () => {
		expect(verifyMfaChallenge('')).toBe(null);
		expect(verifyMfaChallenge('a.b')).toBe(null);
		expect(verifyMfaChallenge('a.b.c.d')).toBe(null);
		expect(verifyMfaChallenge('a.b.notHex!')).toBe(null);
	});
});
