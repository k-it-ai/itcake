import { describe, it, expect, beforeAll } from 'vitest';

describe('field-crypto', () => {
	// SESSION_SECRET is seeded by vite.config.ts before any module loads —
	// see the top-of-file note there. We just import the functions here.
	let encryptField: (plaintext: string, aad?: string) => string;
	let decryptField: (ciphertext: string, aad?: string) => string;
	let isEncryptedField: (value: string) => boolean;

	beforeAll(async () => {
		const mod = await import('../../src/lib/server/field-crypto.js');
		encryptField = mod.encryptField;
		decryptField = mod.decryptField;
		isEncryptedField = mod.isEncryptedField;
	});

	it('encrypts with v2 format and decrypts round-trip', () => {
		const plaintext = 'my-smtp-password-123';
		const encrypted = encryptField(plaintext);
		expect(encrypted).toMatch(/^enc2:/);
		expect(encrypted).not.toContain(plaintext);
		expect(decryptField(encrypted)).toBe(plaintext);
	});

	it('returns empty strings unchanged', () => {
		expect(encryptField('')).toBe('');
	});

	it('returns non-prefixed strings unchanged from decrypt', () => {
		expect(decryptField('plain-text')).toBe('plain-text');
	});

	it('produces different ciphertexts for same plaintext (random salt + IV)', () => {
		const a = encryptField('test');
		const b = encryptField('test');
		expect(a).not.toBe(b);
		expect(decryptField(a)).toBe('test');
		expect(decryptField(b)).toBe('test');
	});

	it('handles unicode in plaintext', () => {
		const plaintext = 'pässwörd-ünïcödé-🔑';
		const encrypted = encryptField(plaintext);
		expect(decryptField(encrypted)).toBe(plaintext);
	});

	it('returns empty string for corrupted v2 ciphertext', () => {
		expect(decryptField('enc2:not-valid-base64!!!')).toBe('');
	});

	it('returns empty string for corrupted v1 ciphertext', () => {
		expect(decryptField('enc:not-valid-base64!!!')).toBe('');
	});

	// v3 format: AAD-bound ciphertexts. Same `aad` must be passed on decrypt.
	it('encrypts with v3 format when an AAD is supplied', () => {
		const enc = encryptField('secret', 'agent.hmacSecret:abc123');
		expect(enc).toMatch(/^enc3:/);
	});

	it('round-trips a v3 ciphertext with the matching AAD', () => {
		const enc = encryptField('secret', 'agent.hmacSecret:abc');
		expect(decryptField(enc, 'agent.hmacSecret:abc')).toBe('secret');
	});

	it('refuses to decrypt v3 with a different AAD (cross-row substitution defence)', () => {
		const enc = encryptField('secret-A', 'agent.hmacSecret:agent-A');
		// A DB writer who copies this ciphertext into agent-B's row will
		// pass `agent.hmacSecret:agent-B` at decrypt — must fail.
		expect(decryptField(enc, 'agent.hmacSecret:agent-B')).toBe('');
	});

	it('refuses to decrypt v3 when no AAD is supplied', () => {
		const enc = encryptField('secret', 'agent.hmacSecret:abc');
		expect(decryptField(enc)).toBe('');
	});

	it('decrypts v2 ciphertexts even when an AAD is supplied (backward compat)', () => {
		const v2 = encryptField('legacy-value');
		expect(v2).toMatch(/^enc2:/);
		expect(decryptField(v2, 'agent.hmacSecret:any')).toBe('legacy-value');
	});

	it('produces different v3 ciphertexts for same plaintext + same AAD (random salt)', () => {
		const a = encryptField('s', 'lbl');
		const b = encryptField('s', 'lbl');
		expect(a).not.toBe(b);
		expect(decryptField(a, 'lbl')).toBe('s');
		expect(decryptField(b, 'lbl')).toBe('s');
	});

	describe('isEncryptedField', () => {
		// Tightening of the loose `startsWith('enc')` check used to gate
		// re-encrypts. The previous check accepted any value beginning
		// with the three letters "enc" — including a passphrase like
		// `enc:test` (treated as a v1 ciphertext, decrypts to garbage)
		// and `encryption-passphrase` (passed through to decrypt as
		// non-prefixed plaintext). The new strict check matches only
		// real version prefixes: `enc:`, `enc2:`, `enc3:`, `encN:`.
		it('matches valid version prefixes', () => {
			expect(isEncryptedField('enc:abc')).toBe(true);
			expect(isEncryptedField('enc2:abc')).toBe(true);
			expect(isEncryptedField('enc3:abc')).toBe(true);
			// Forward-compat: future enc4/enc5 should also pass without
			// touching this helper. The current decryptField doesn't
			// understand them, but the prefix check is permissive on
			// digits.
			expect(isEncryptedField('enc4:abc')).toBe(true);
		});

		it('rejects plaintext that happens to start with "enc"', () => {
			// These were the false-positives under the old check and
			// would have triggered a decrypt branch on plaintext that
			// just happened to share the prefix.
			expect(isEncryptedField('encryption-passphrase')).toBe(false);
			expect(isEncryptedField('encore!')).toBe(false);
			expect(isEncryptedField('enc-without-colon')).toBe(false);
			expect(isEncryptedField('encoded')).toBe(false);
		});

		it('rejects empty / non-prefix strings', () => {
			expect(isEncryptedField('')).toBe(false);
			expect(isEncryptedField('plain text')).toBe(false);
			expect(isEncryptedField(':enc')).toBe(false);
		});
	});
});
