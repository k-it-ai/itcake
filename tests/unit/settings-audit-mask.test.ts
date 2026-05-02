import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

const TEST_DIR = path.resolve('data-test-settings-audit-mask');

let db: Database;
let updateSettingsSection: typeof import('../../src/services/settings.js').updateSettingsSection;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'sam.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	db = (await import('../../src/lib/server/db.js')).db;
	updateSettingsSection = (await import('../../src/services/settings.js')).updateSettingsSection;

	db.prepare(
		`INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)`
	).run('audit-actor', 'audit@test', 'hash');
});

function latestBackupAuditDiff(): Record<string, unknown> {
	const row = db
		.prepare("SELECT diff FROM changes WHERE entity_type = 'settings' AND entity_id = 'backup' ORDER BY created_at DESC, id DESC LIMIT 1")
		.get() as { diff: string } | undefined;
	if (!row) throw new Error('no backup audit row');
	return JSON.parse(row.diff);
}

describe('updateSettingsSection — backup audit diff masking (M6 regression)', () => {
	it('masks encryptionPassphrase in the audit log diff', () => {
		updateSettingsSection('backup', { encryptionPassphrase: 'super-secret-passphrase-123' }, 'audit-actor');
		const diff = latestBackupAuditDiff();
		const dStr = JSON.stringify(diff);
		expect(dStr).not.toContain('super-secret-passphrase-123');
		expect(dStr).not.toContain('enc2:');
		expect(dStr).not.toContain('enc3:');
		expect(diff.encryptionPassphrase).toEqual({ old: '***', new: '***' });
	});

	it('masks s3.secretAccessKey and webdav.password in the audit log diff', () => {
		updateSettingsSection('backup', {
			offsite: {
				enabled: true,
				target: 's3',
				schedule: 'daily',
				s3: {
					endpoint: 'https://s3.example.com',
					region: 'us-east-1',
					bucket: 'my-bucket',
					accessKeyId: 'AKIA123',
					secretAccessKey: 'TOTALLY-SECRET-S3-KEY',
					pathPrefix: 'itcake/'
				},
				webdav: {
					url: '',
					username: '',
					password: 'TOTALLY-SECRET-WEBDAV-PW'
				},
				retentionDays: 30,
				lastUpload: null
			}
		}, 'audit-actor');

		const diff = latestBackupAuditDiff();
		const dStr = JSON.stringify(diff);
		expect(dStr).not.toContain('TOTALLY-SECRET-S3-KEY');
		expect(dStr).not.toContain('TOTALLY-SECRET-WEBDAV-PW');
		expect(dStr).not.toContain('enc2:');
		expect(dStr).not.toContain('enc3:');

		type S3 = { secretAccessKey?: string; bucket?: string; accessKeyId?: string };
		type WD = { password?: string };
		const off = diff.offsite as { old: { s3?: S3; webdav?: WD }; new: { s3?: S3; webdav?: WD } };
		expect(off.new.s3?.secretAccessKey).toBe('***');
		expect(off.new.webdav?.password).toBe('***');
		// non-secret fields stay visible
		expect(off.new.s3?.bucket).toBe('my-bucket');
		expect(off.new.s3?.accessKeyId).toBe('AKIA123');
	});
});
