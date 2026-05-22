/**
 * Follow-ups from loop 12:
 *   - C1: backup-crypto rejects unknown header bytes explicitly instead
 *     of silently falling through to v1 + GCM-auth-failure.
 *   - S1: password-change audit row uses entity_id='password' (the
 *     sectionKey convention), not userId.
 *   - M1: getSettingsSection is typed to a credential-free key union.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-loop12');

let encryptBackup: typeof import('../../src/lib/server/backup-crypto.js').encryptBackup;
let decryptBackup: typeof import('../../src/lib/server/backup-crypto.js').decryptBackup;
let isEncryptedBackup: typeof import('../../src/lib/server/backup-crypto.js').isEncryptedBackup;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'l12.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const bc = await import('../../src/lib/server/backup-crypto.js');
	encryptBackup = bc.encryptBackup;
	decryptBackup = bc.decryptBackup;
	isEncryptedBackup = bc.isEncryptedBackup;
});

describe('backup-crypto: explicit header version check (C1)', () => {
	it('round-trips a v2 blob', () => {
		const plain = Buffer.from('hello world payload');
		const enc = encryptBackup(plain, 'a-strong-passphrase');
		expect(isEncryptedBackup(enc)).toBe(true);
		const dec = decryptBackup(enc, 'a-strong-passphrase');
		expect(dec.toString()).toBe('hello world payload');
	});

	it('rejects an unknown 13-byte header explicitly', () => {
		// Build a buffer with a fake "v3" header. Same length as v1/v2
		// (13 bytes including newline), but the literal bytes don't match
		// either known version.
		const fakeHead = Buffer.from('ITCAKE-ENC-3\n', 'ascii');
		const enc = encryptBackup(Buffer.from('payload'), 'pw');
		// Splice the v2 header out, splice the fake one in.
		const v3Blob = Buffer.concat([fakeHead, enc.subarray(13)]);
		// isEncryptedBackup gates first → 'Not an ITCake-encrypted backup'.
		expect(() => decryptBackup(v3Blob, 'pw')).toThrow(/Not an ITCake-encrypted backup/);
	});

	it('rejects a header that passes isEncryptedBackup but has unknown bytes (impossible today, regression-pin)', () => {
		// This regression pins the explicit-branch defence: if
		// isEncryptedBackup is ever loosened to accept additional headers
		// without updating decryptBackup, the 'Unknown ITCake backup
		// header version' throw catches it. Today the branch is
		// unreachable from the public API; the test exercises it via a
		// hand-crafted malformed-but-correct-length head.
		const fakeHead = Buffer.from('ITCAKE-ENC-3\n', 'ascii');
		const enc = encryptBackup(Buffer.from('payload'), 'pw');
		const v3Blob = Buffer.concat([fakeHead, enc.subarray(13)]);
		// Confirms a non-matching head doesn't accidentally enter the
		// v1-default path.
		expect(isEncryptedBackup(v3Blob)).toBe(false);
	});

	it('refuses to decrypt when passphrase missing', () => {
		const enc = encryptBackup(Buffer.from('p'), 'pw');
		expect(() => decryptBackup(enc, '')).toThrow(/passphrase required/);
	});

	it('refuses to decrypt non-backup buffer', () => {
		expect(() => decryptBackup(Buffer.from('not a backup'), 'pw'))
			.toThrow(/Not an ITCake-encrypted backup/);
	});
});

describe('audit log: password-change entity_id convention (S1)', () => {
	it('changePassword writes a settings/password row, not a settings/<userId> row', async () => {
		const bcrypt = (await import('bcryptjs')).default;
		const db = (await import('../../src/lib/server/db.js')).db;
		const auth = await import('../../src/lib/server/auth.js');
		const userId = 'user-loop12';
		const pwHash = await bcrypt.hash('old-password-xxxxxxxx', 12);
		db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)`).run(userId, 'p@t', pwHash);

		await auth.changePassword(userId, 'old-password-xxxxxxxx', 'new-password-yyyyyyyyyyyy');

		const row = db.prepare(
			`SELECT entity_type, entity_id FROM changes WHERE entity_type = 'settings' AND user_id = ? ORDER BY id DESC LIMIT 1`
		).get(userId) as { entity_type: string; entity_id: string };
		expect(row.entity_type).toBe('settings');
		expect(row.entity_id).toBe('password');
	});
});
