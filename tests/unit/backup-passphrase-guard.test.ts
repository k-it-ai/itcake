import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-backup-passphrase');

let createBackup: typeof import('../../src/services/backups.js').createBackup;
let BackupPassphraseUnreadableError: typeof import('../../src/services/backups.js').BackupPassphraseUnreadableError;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;
let encryptField: typeof import('../../src/lib/server/field-crypto.js').encryptField;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'bkp.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const fc = await import('../../src/lib/server/field-crypto.js');
	const bk = await import('../../src/services/backups.js');
	db = dbMod.db;
	setSetting = dbMod.setSetting;
	encryptField = fc.encryptField;
	createBackup = bk.createBackup;
	BackupPassphraseUnreadableError = bk.BackupPassphraseUnreadableError;
});

describe('backup passphrase guard', () => {
	it('refuses to write a plaintext backup when configured passphrase ciphertext cannot be decrypted', async () => {
		const real = encryptField('correct-horse-battery-staple');
		const corrupted = real.slice(0, real.length - 6) + 'XXXXXX';
		const existing = (db.prepare("SELECT value FROM settings WHERE key = 'backup'").get() as { value: string } | undefined)?.value;
		const baseline = existing ? JSON.parse(existing) : {};
		setSetting('backup', { ...baseline, encryptionPassphrase: corrupted });

		await expect(createBackup()).rejects.toBeInstanceOf(BackupPassphraseUnreadableError);
	}, 30_000);

	it('writes an encrypted backup (.zip.enc) when the configured passphrase decrypts cleanly', async () => {
		const real = encryptField('correct-horse-battery-staple');
		const existing = (db.prepare("SELECT value FROM settings WHERE key = 'backup'").get() as { value: string } | undefined)?.value;
		const baseline = existing ? JSON.parse(existing) : {};
		setSetting('backup', { ...baseline, encryptionPassphrase: real });

		const info = await createBackup();
		expect(info.filename.endsWith('.zip.enc')).toBe(true);
	}, 30_000);

	it('elides the passphrase ciphertext from the settings row inside the backup', async () => {
		setSetting('backup', { encryptionPassphrase: encryptField('the-secret') });

		const info = await createBackup();
		expect(info.filename.endsWith('.zip.enc')).toBe(true);

		const { readFileSync } = await import('node:fs');
		const { decryptBackup } = await import('../../src/lib/server/backup-crypto.js');
		const blob = readFileSync(path.join(TEST_DIR, 'backups', info.filename));
		const plain = decryptBackup(blob, 'the-secret');
		const JSZip = (await import('jszip')).default;
		const zip = await JSZip.loadAsync(plain);
		const dbBuf = await zip.file('itcake.db')!.async('nodebuffer');
		const Database = (await import('better-sqlite3')).default;
		const tmp = path.join(TEST_DIR, '_inspect.db');
		const fs = await import('node:fs');
		fs.writeFileSync(tmp, dbBuf);
		try {
			const inspect = new Database(tmp, { readonly: true });
			const row = inspect.prepare("SELECT value FROM settings WHERE key = 'backup'").get() as { value: string } | undefined;
			inspect.close();
			expect(row).toBeTruthy();
			const parsed = JSON.parse(row!.value);
			expect(parsed.encryptionPassphrase).toBe('');
		} finally {
			fs.unlinkSync(tmp);
		}
	}, 30_000);
});
