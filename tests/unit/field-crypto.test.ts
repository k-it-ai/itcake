import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('field-crypto', () => {
	let encryptField: (plaintext: string) => string;
	let decryptField: (ciphertext: string) => string;

	beforeEach(async () => {
		vi.stubEnv('SESSION_SECRET', 'test-secret-for-encryption-32chars!!');
		const mod = await import('../../src/lib/server/field-crypto.js');
		encryptField = mod.encryptField;
		decryptField = mod.decryptField;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
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
});
