import { describe, it, expect } from 'vitest';
import { backupSettingsSchema } from '../../src/lib/validators.js';

describe('backupSettingsSchema', () => {
	it('accepts the seeded defaults', () => {
		const r = backupSettingsSchema.safeParse({
			encryptionPassphrase: '',
			offsite: {
				enabled: false,
				schedule: 'daily',
				target: 's3',
				s3: { endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: '', secretAccessKey: '', pathPrefix: 'itcake/' },
				webdav: { url: '', username: '', password: '' },
				retentionDays: 30,
				lastUpload: null
			}
		});
		expect(r.success).toBe(true);
	});

	it('accepts a configured S3 target', () => {
		const r = backupSettingsSchema.safeParse({
			encryptionPassphrase: 'super-secret-passphrase',
			offsite: {
				enabled: true,
				schedule: 'weekly',
				target: 's3',
				s3: { endpoint: 'https://s3.eu-central-003.backblazeb2.com', region: 'eu-central-003', bucket: 'my-itcake-backups', accessKeyId: 'AKIA...', secretAccessKey: 'plain-secret', pathPrefix: 'mycompany/' },
				webdav: { url: '', username: '', password: '' },
				retentionDays: 90
			}
		});
		expect(r.success).toBe(true);
	});

	it('rejects unknown schedule value', () => {
		const r = backupSettingsSchema.safeParse({
			encryptionPassphrase: '',
			offsite: { enabled: false, schedule: 'every-tuesday', target: 's3', s3: {}, webdav: {}, retentionDays: 30 }
		});
		expect(r.success).toBe(false);
	});

	it('rejects unknown target', () => {
		const r = backupSettingsSchema.safeParse({
			encryptionPassphrase: '',
			offsite: { enabled: false, schedule: 'daily', target: 'ftp', s3: {}, webdav: {}, retentionDays: 30 }
		});
		expect(r.success).toBe(false);
	});

	it('rejects retentionDays outside bounds', () => {
		const r = backupSettingsSchema.safeParse({
			encryptionPassphrase: '',
			offsite: { enabled: false, schedule: 'daily', target: 's3', s3: {}, webdav: {}, retentionDays: 0 }
		});
		expect(r.success).toBe(false);
	});

	it('preserves the masked sentinel for round-trip', () => {
		// must accept it (services/settings.ts replaces it with the prior
		const r = backupSettingsSchema.safeParse({
			encryptionPassphrase: '***',
			offsite: { enabled: true, schedule: 'daily', target: 'webdav',
				s3: {},
				webdav: { url: 'https://nextcloud.example.org/dav/', username: 'me', password: '***' },
				retentionDays: 14 }
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.encryptionPassphrase).toBe('***');
			expect(r.data.offsite.webdav.password).toBe('***');
		}
	});
});
