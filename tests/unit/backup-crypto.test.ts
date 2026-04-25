/**
 * Round-trip + tampering tests for the optional passphrase-based wrapper
 * applied to backup ZIPs before they leave the box. The actual ZIP
 * contents are tested elsewhere; here we only verify the outer layer.
 */
import { describe, it, expect } from 'vitest';
import {
	encryptBackup,
	decryptBackup,
	isEncryptedBackup,
	ENCRYPTED_BACKUP_EXT
} from '../../src/lib/server/backup-crypto.js';

const PASSPHRASE = 'correct horse battery staple';
const PAYLOAD = Buffer.from('PK\x03\x04 fake-zip-bytes here'.repeat(64));

describe('backup-crypto', () => {
	it('round-trips a buffer through encrypt/decrypt', () => {
		const enc = encryptBackup(PAYLOAD, PASSPHRASE);
		expect(isEncryptedBackup(enc)).toBe(true);
		const dec = decryptBackup(enc, PASSPHRASE);
		expect(dec.equals(PAYLOAD)).toBe(true);
	});

	it('produces different ciphertext on each call (fresh salt+iv)', () => {
		const a = encryptBackup(PAYLOAD, PASSPHRASE);
		const b = encryptBackup(PAYLOAD, PASSPHRASE);
		expect(a.equals(b)).toBe(false);
	});

	it('rejects the wrong passphrase', () => {
		const enc = encryptBackup(PAYLOAD, PASSPHRASE);
		expect(() => decryptBackup(enc, 'wrong')).toThrow();
	});

	it('rejects a tampered ciphertext (GCM tag fails)', () => {
		const enc = encryptBackup(PAYLOAD, PASSPHRASE);
		// Flip a byte in the ciphertext region (after header+salt+iv+tag = 13+16+12+16 = 57)
		const tampered = Buffer.from(enc);
		tampered[100] ^= 0xff;
		expect(() => decryptBackup(tampered, PASSPHRASE)).toThrow();
	});

	it('rejects a missing/wrong header', () => {
		// A plain ZIP isn't an encrypted backup — must throw rather than try
		// to "interpret" an unencrypted file as if it were ours.
		expect(() => decryptBackup(Buffer.from('PK\x03\x04ordinary zip'), PASSPHRASE)).toThrow();
	});

	it('refuses an empty passphrase on encrypt and decrypt', () => {
		expect(() => encryptBackup(PAYLOAD, '')).toThrow();
		const enc = encryptBackup(PAYLOAD, PASSPHRASE);
		expect(() => decryptBackup(enc, '')).toThrow();
	});

	it('exports the expected file extension constant', () => {
		expect(ENCRYPTED_BACKUP_EXT).toBe('.zip.enc');
	});

	it('isEncryptedBackup distinguishes wrapped vs plain', () => {
		const enc = encryptBackup(PAYLOAD, PASSPHRASE);
		expect(isEncryptedBackup(enc)).toBe(true);
		expect(isEncryptedBackup(PAYLOAD)).toBe(false);
		expect(isEncryptedBackup(Buffer.from(''))).toBe(false);
	});
});
