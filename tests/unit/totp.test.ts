import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// tracker), so we must point DATABASE_PATH at a disposable file before
const TEST_DIR = path.resolve('data-test-totp');

let base32Encode: typeof import('../../src/lib/server/totp.js').base32Encode;
let base32Decode: typeof import('../../src/lib/server/totp.js').base32Decode;
let generateTotpSecret: typeof import('../../src/lib/server/totp.js').generateTotpSecret;
let totp: typeof import('../../src/lib/server/totp.js').totp;
let totpVerify: typeof import('../../src/lib/server/totp.js').totpVerify;
let totpUri: typeof import('../../src/lib/server/totp.js').totpUri;
let generateRecoveryCodes: typeof import('../../src/lib/server/totp.js').generateRecoveryCodes;
let hashRecoveryCode: typeof import('../../src/lib/server/totp.js').hashRecoveryCode;
let signMfaChallenge: typeof import('../../src/lib/server/totp.js').signMfaChallenge;
let verifyMfaChallenge: typeof import('../../src/lib/server/totp.js').verifyMfaChallenge;
let consumeMfaChallenge: typeof import('../../src/lib/server/totp.js').consumeMfaChallenge;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'totp.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const m = await import('../../src/lib/server/totp.js');
	base32Encode = m.base32Encode;
	base32Decode = m.base32Decode;
	generateTotpSecret = m.generateTotpSecret;
	totp = m.totp;
	totpVerify = m.totpVerify;
	totpUri = m.totpUri;
	generateRecoveryCodes = m.generateRecoveryCodes;
	hashRecoveryCode = m.hashRecoveryCode;
	signMfaChallenge = m.signMfaChallenge;
	verifyMfaChallenge = m.verifyMfaChallenge;
	consumeMfaChallenge = m.consumeMfaChallenge;
});

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
		expect(() => base32Decode('1MZXW6')).not.toThrow();
	});
});

describe('TOTP (RFC 6238 reference vectors)', () => {
	// RFC 6238 Appendix B test vectors. The reference key is "12345678901234567890" (ASCII).
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
		const earlier = totp(SECRET, t - 30_000);
		expect(totpVerify(SECRET, earlier, t)).toBe(true);
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
	it('generates 10 unique 16-character codes (80-bit entropy)', () => {
		const codes = generateRecoveryCodes();
		expect(codes.length).toBe(10);
		expect(new Set(codes).size).toBe(10);
		for (const c of codes) {
			expect(c).toMatch(/^[A-Z2-7]{16}$/);
		}
	});

	it('hash is deterministic for normalized input', () => {
		const code = 'ABCD2345';
		expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code));
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
		const parts = tok.split('.');
		const tampered = `attacker.${parts[1]}.${parts[2]}.${parts[3]}`;
		expect(verifyMfaChallenge(tampered)).toBe(null);
	});

	it('rejects malformed tokens', () => {
		expect(verifyMfaChallenge('')).toBe(null);
		expect(verifyMfaChallenge('a.b')).toBe(null);
		expect(verifyMfaChallenge('a.b.c')).toBe(null);
		expect(verifyMfaChallenge('a.b.c.d.e')).toBe(null);
		expect(verifyMfaChallenge('a.b.notHex!')).toBe(null);
	});

	it('rejects legacy 3-part tokens even when HMAC is valid', async () => {
		const crypto = await import('node:crypto');
		const secret = process.env.SESSION_SECRET!;
		const userId = 'user-legacy';
		const exp = Math.floor(Date.now() / 1000) + 60;
		const payload = `${userId}.${exp}`;
		const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
		expect(verifyMfaChallenge(`${payload}.${sig}`)).toBe(null);
		expect(consumeMfaChallenge(`${payload}.${sig}`)).toBe(false);
	});

	it('verifyMfaChallenge is read-only — repeated verifies stay valid', () => {
		const tok = signMfaChallenge('user-r1', 60);
		expect(verifyMfaChallenge(tok)).toEqual({ userId: 'user-r1' });
		expect(verifyMfaChallenge(tok)).toEqual({ userId: 'user-r1' });
		expect(verifyMfaChallenge(tok)).toEqual({ userId: 'user-r1' });
	});

	it('consumeMfaChallenge marks the token single-use', () => {
		const tok = signMfaChallenge('user-c1', 60);
		expect(consumeMfaChallenge(tok)).toBe(true);
		expect(consumeMfaChallenge(tok)).toBe(false);
		expect(verifyMfaChallenge(tok)).toBe(null);
	});

	it('consumeMfaChallenge rejects expired and tampered tokens', () => {
		const expired = signMfaChallenge('user-c2', -1);
		expect(consumeMfaChallenge(expired)).toBe(false);

		const valid = signMfaChallenge('user-c3', 60);
		const parts = valid.split('.');
		const tampered = `evil.${parts[1]}.${parts[2]}.${parts[3]}`;
		expect(consumeMfaChallenge(tampered)).toBe(false);
		expect(consumeMfaChallenge(valid)).toBe(true);
	});
});
