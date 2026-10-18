import { describe, it, expect } from 'vitest';
import { backupSettingsSchema } from '../../src/lib/validators-settings.js';

describe('backupSettingsSchema', () => {
	it('accepts the seeded defaults', () => {
		const r = backupSettingsSchema.safeParse({ encryptionPassphrase: '' });
		expect(r.success).toBe(true);
	});

	it('accepts a configured passphrase', () => {
		const r = backupSettingsSchema.safeParse({ encryptionPassphrase: 'super-secret-passphrase' });
		expect(r.success).toBe(true);
	});

	it('preserves the masked sentinel for round-trip', () => {
		// services/settings.ts replaces it with the stored passphrase on save.
		const r = backupSettingsSchema.safeParse({ encryptionPassphrase: '***' });
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.encryptionPassphrase).toBe('***');
	});

	it('rejects a non-string passphrase', () => {
		const r = backupSettingsSchema.safeParse({ encryptionPassphrase: 123 });
		expect(r.success).toBe(false);
	});
});
