/**
 * Regression test for an old bug in migrateSettingsCredentialsToV3:
 * the enc2→enc3 upgrade encrypted with AAD = bare label (e.g.
 * "backup.encryptionPassphrase") but the runtime read path uses AAD
 * "backup.encryptionPassphrase:1" — the credential was silently
 * unrecoverable after upgrade. repairLegacyEnc3SettingsAad re-encrypts
 * blobs that decrypt with the bare-label AAD using the canonical `:1`
 * form so the read path picks them up again.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-repair-legacy-aad');

let db: typeof import('../../src/lib/server/db.js').db;
let getSetting: typeof import('../../src/lib/server/db.js').getSetting;
let repairLegacyEnc3SettingsAad: typeof import('../../src/lib/server/db.js').repairLegacyEnc3SettingsAad;
let encryptField: typeof import('../../src/lib/server/field-crypto.js').encryptField;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'r.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	getSetting = dbMod.getSetting;
	repairLegacyEnc3SettingsAad = dbMod.repairLegacyEnc3SettingsAad;
	const fc = await import('../../src/lib/server/field-crypto.js');
	encryptField = fc.encryptField;
});

describe('repairLegacyEnc3SettingsAad', () => {
	it('rewraps a bare-label-AAD blob with the canonical :1 form so getSetting can read it again', () => {
		const buggy = encryptField('super-secret-passphrase', 'backup.encryptionPassphrase');
		expect(buggy.startsWith('enc3:')).toBe(true);
		db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup', ?)").run(
			JSON.stringify({ encryptionPassphrase: buggy })
		);

		const beforeRead = getSetting<{ encryptionPassphrase: string }>('backup');
		expect(beforeRead.encryptionPassphrase).not.toBe('super-secret-passphrase');

		const fixed = repairLegacyEnc3SettingsAad();
		expect(fixed).toBeGreaterThanOrEqual(1);

		const afterRead = getSetting<{ encryptionPassphrase: string }>('backup');
		expect(afterRead.encryptionPassphrase).toBe('super-secret-passphrase');
	});

	it('is a no-op when blobs are already canonical', () => {
		const ok = encryptField('clean-key', 'ai.apiKey:1');
		db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai', ?)").run(
			JSON.stringify({ apiKey: ok, enabled: true })
		);
		expect(repairLegacyEnc3SettingsAad()).toBe(0);
	});
});
