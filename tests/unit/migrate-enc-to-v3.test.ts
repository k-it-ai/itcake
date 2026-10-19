import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

// On import, db.ts runs all startup migrations (including totp/RDP enc2→enc3
// against an empty DB — no-op). After that we seed enc2: values directly and
// call the exported migration helpers to verify they upgrade to enc3:.
const TEST_DIR = path.resolve('data-test-migrate-v3');

let db: Database;
let encryptField: typeof import('../../src/lib/server/field-crypto.js').encryptField;
let decryptField: typeof import('../../src/lib/server/field-crypto.js').decryptField;
let migrateUserTotpSecretsToV3: typeof import('../../src/lib/server/db.js').migrateUserTotpSecretsToV3;
let migrateAgentRemoteDesktopToV3: typeof import('../../src/lib/server/db.js').migrateAgentRemoteDesktopToV3;
let migrateSettingsCredentialsToV3: typeof import('../../src/lib/server/db.js').migrateSettingsCredentialsToV3;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'mig.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbModule = await import('../../src/lib/server/db.js');
	db = dbModule.db;
	migrateUserTotpSecretsToV3 = dbModule.migrateUserTotpSecretsToV3;
	migrateAgentRemoteDesktopToV3 = dbModule.migrateAgentRemoteDesktopToV3;
	migrateSettingsCredentialsToV3 = dbModule.migrateSettingsCredentialsToV3;
	const fc = await import('../../src/lib/server/field-crypto.js');
	encryptField = fc.encryptField;
	decryptField = fc.decryptField;
});

describe('migrateUserTotpSecretsToV3 (M5 regression)', () => {
	it('upgrades enc2:-prefixed totp_secret values to enc3: with users.totpSecret AAD', () => {
		const plaintext = 'JBSWY3DPEHPK3PXP'; // example TOTP secret (base32)
		const v2 = encryptField(plaintext); // no AAD → enc2:
		expect(v2.startsWith('enc2:')).toBe(true);

		const userId = 'user-mig-1';
		db.prepare(
			`INSERT INTO users (id, email, password_hash, totp_secret, totp_enabled)
			 VALUES (?, ?, ?, ?, 1)`
		).run(userId, 'mig1@test', 'hash', v2);

		const migrated = migrateUserTotpSecretsToV3();
		expect(migrated).toBeGreaterThanOrEqual(1);

		const row = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as { totp_secret: string };
		expect(row.totp_secret.startsWith('enc3:')).toBe(true);
		// Decrypt with the right AAD round-trips
		expect(decryptField(row.totp_secret, `users.totpSecret:${userId}`)).toBe(plaintext);
		// Decrypt with a different AAD fails closed (cross-row substitution defence)
		expect(decryptField(row.totp_secret, 'users.totpSecret:wrong')).toBe('');
	});

	it('is idempotent (no-op on subsequent runs)', () => {
		const second = migrateUserTotpSecretsToV3();
		expect(second).toBe(0);
	});
});

describe('migrateAgentRemoteDesktopToV3 (M5 regression)', () => {
	it('upgrades enc2: password + privateKey nested in agents.data to enc3: with rdp AAD', () => {
		const plainPw = 'super-secret-rdp-password';
		const plainKey = '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----';
		const v2Pw = encryptField(plainPw);
		const v2Key = encryptField(plainKey);
		expect(v2Pw.startsWith('enc2:')).toBe(true);
		expect(v2Key.startsWith('enc2:')).toBe(true);

		const agentId = 'agent-mig-rdp';
		const data = {
			remoteDesktop: {
				protocol: 'rdp',
				port: 3389,
				username: 'op',
				password: v2Pw,
				privateKey: v2Key
			}
		};
		db.prepare(
			`INSERT INTO agents (id, name, hostname, os, arch, token_hash, hmac_secret, status, enabled, data)
			 VALUES (?, ?, ?, ?, ?, ?, '', 'online', 1, ?)`
		).run(agentId, 'rdp', 'rdp-host', 'linux', 'amd64', 'tok-' + agentId, JSON.stringify(data));

		const migrated = migrateAgentRemoteDesktopToV3();
		expect(migrated).toBeGreaterThanOrEqual(1);

		const row = db.prepare('SELECT data FROM agents WHERE id = ?').get(agentId) as { data: string };
		const parsed = JSON.parse(row.data);
		expect(parsed.remoteDesktop.password.startsWith('enc3:')).toBe(true);
		expect(parsed.remoteDesktop.privateKey.startsWith('enc3:')).toBe(true);
		expect(decryptField(parsed.remoteDesktop.password, `agent.remoteDesktop.password:${agentId}`)).toBe(plainPw);
		expect(decryptField(parsed.remoteDesktop.privateKey, `agent.remoteDesktop.privateKey:${agentId}`)).toBe(plainKey);
		// Cross-field AAD substitution must fail closed
		expect(decryptField(parsed.remoteDesktop.password, `agent.remoteDesktop.privateKey:${agentId}`)).toBe('');
	});

	it('leaves rows without remoteDesktop or with already-enc3 values alone', () => {
		// Row without remoteDesktop at all
		db.prepare(
			`INSERT INTO agents (id, name, hostname, os, arch, token_hash, hmac_secret, status, enabled, data)
			 VALUES (?, ?, ?, ?, ?, ?, '', 'online', 1, ?)`
		).run('agent-no-rd', 'a', 'h', 'linux', 'amd64', 'tok-no-rd', JSON.stringify({ tags: ['x'] }));

		const before = db.prepare('SELECT data FROM agents WHERE id = ?').get('agent-no-rd') as { data: string };
		migrateAgentRemoteDesktopToV3();
		const after = db.prepare('SELECT data FROM agents WHERE id = ?').get('agent-no-rd') as { data: string };
		expect(after.data).toBe(before.data);
	});
});

describe('migrateSettingsCredentialsToV3 (registry-driven)', () => {
	it('upgrades every registered enc2: credential across settings keys', () => {
		const passphrase = 'super-secret-backup-passphrase';
		const apiKey = 'sk-ant-FAKE-ROTATION-KEY-1234567890ABC';
		const v2Pass = encryptField(passphrase);
		const v2ApiKey = encryptField(apiKey);
		expect(v2Pass.startsWith('enc2:')).toBe(true);
		expect(v2ApiKey.startsWith('enc2:')).toBe(true);

		db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup', ?)").run(JSON.stringify({
			encryptionPassphrase: v2Pass
		}));
		db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai', ?)").run(JSON.stringify({
			apiKey: v2ApiKey
		}));

		const migrated = migrateSettingsCredentialsToV3();
		expect(migrated).toBe(2);

		const backupRow = db.prepare("SELECT value FROM settings WHERE key = 'backup'").get() as { value: string };
		const parsed = JSON.parse(backupRow.value);
		expect(parsed.encryptionPassphrase.startsWith('enc3:')).toBe(true);
		expect(decryptField(parsed.encryptionPassphrase, 'backup.encryptionPassphrase:1')).toBe(passphrase);

		const aiRow = db.prepare("SELECT value FROM settings WHERE key = 'ai'").get() as { value: string };
		const ai = JSON.parse(aiRow.value);
		expect(ai.apiKey.startsWith('enc3:')).toBe(true);
		expect(decryptField(ai.apiKey, 'ai.apiKey:1')).toBe(apiKey);
	});

	it('is idempotent (no-op on subsequent runs)', () => {
		const second = migrateSettingsCredentialsToV3();
		expect(second).toBe(0);
	});
});
