import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-passphrase-rotation');

let rotateBackupPassphrase: typeof import('../../src/services/backups.js').rotateBackupPassphrase;
let getBackups: typeof import('../../src/services/backups.js').getBackups;
let decryptBackup: typeof import('../../src/lib/server/backup-crypto.js').decryptBackup;
let encryptBackup: typeof import('../../src/lib/server/backup-crypto.js').encryptBackup;
let isEncryptedBackup: typeof import('../../src/lib/server/backup-crypto.js').isEncryptedBackup;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'br.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	await import('../../src/lib/server/db.js');
	const backups = await import('../../src/services/backups.js');
	rotateBackupPassphrase = backups.rotateBackupPassphrase;
	getBackups = backups.getBackups;
	const crypto = await import('../../src/lib/server/backup-crypto.js');
	decryptBackup = crypto.decryptBackup;
	encryptBackup = crypto.encryptBackup;
	isEncryptedBackup = crypto.isEncryptedBackup;
});

const BACKUP_DIR = () => path.join(TEST_DIR, 'backups');

async function writeFakeBackup(filename: string, contents: string, passphrase: string | null): Promise<void> {
	mkdirSync(BACKUP_DIR(), { recursive: true });
	const zip = new JSZip();
	zip.file('payload.txt', contents);
	const raw = await zip.generateAsync({ type: 'nodebuffer' });
	const blob = passphrase ? encryptBackup(raw, passphrase) : raw;
	writeFileSync(path.join(BACKUP_DIR(), filename), blob);
}

function ts(seconds: number): string {
	const d = new Date(2026, 0, 1, 0, 0, seconds);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

describe('rotateBackupPassphrase', () => {
	it('rotates every encrypted backup; plaintext backups skipped', async () => {
		const plainName = `backup-${ts(1)}.zip`;
		const enc1Name = `backup-${ts(2)}.zip.enc`;
		const enc2Name = `backup-${ts(3)}.zip.enc`;
		await writeFakeBackup(plainName, 'plain content', null);
		await writeFakeBackup(enc1Name, 'enc1 content', 'OLD-passphrase-1');
		await writeFakeBackup(enc2Name, 'enc2 content', 'OLD-passphrase-1');

		const list = getBackups().map(b => b.filename);
		expect(list).toContain(plainName);
		expect(list).toContain(enc1Name);
		expect(list).toContain(enc2Name);

		const result = rotateBackupPassphrase('OLD-passphrase-1', 'NEW-passphrase-2');
		expect(result.rotated.length).toBe(2);
		expect(result.skippedPlaintext.length).toBe(1);
		expect(result.failed.length).toBe(0);

		const buf1 = readFileSync(path.join(BACKUP_DIR(), enc1Name));
		expect(isEncryptedBackup(buf1)).toBe(true);
		const plain1 = decryptBackup(buf1, 'NEW-passphrase-2');
		expect(plain1.length).toBeGreaterThan(0);
		expect(() => decryptBackup(buf1, 'OLD-passphrase-1')).toThrow();
	});

	it('reports unreadable files in failed[] without aborting the rotation', async () => {
		const target = `backup-${ts(10)}.zip.enc`;
		const survivor = `backup-${ts(11)}.zip.enc`;
		await writeFakeBackup(target, 'doomed', 'WRONG-OLD');
		await writeFakeBackup(survivor, 'survives', 'NEW-passphrase-2');

		const result = rotateBackupPassphrase('NEW-passphrase-2', 'NEW3-passphrase-3');
		expect(result.failed.some(f => f.filename === target)).toBe(true);
		expect(result.rotated.some(r => r.filename === survivor)).toBe(true);
	});

	it('rejects same-passphrase rotation', () => {
		expect(() => rotateBackupPassphrase('same', 'same')).toThrow();
	});
});
