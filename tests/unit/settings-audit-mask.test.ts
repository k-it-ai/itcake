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

function latestAuditDiff(entityId: string): Record<string, unknown> {
	const row = db
		.prepare("SELECT diff FROM changes WHERE entity_type = 'settings' AND entity_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
		.get(entityId) as { diff: string } | undefined;
	if (!row) throw new Error(`no audit row for entity_id=${entityId}`);
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
		expect(diff.encryptionPassphrase).toEqual({ old: '••••••••', new: '••••••••' });
	});

	it('masks ai.apiKey in the audit log diff (regression: report finding #1)', () => {
		// Bypass /api/settings mask-preservation: write a plaintext apiKey
		// directly via updateSettingsSection (which is what the validated
		// route handler does when the user POSTs a real value).
		updateSettingsSection('ai', { enabled: true, apiKey: 'sk-ant-FAKE-FOR-TEST-1234567890ABC' }, 'audit-actor');
		const diff = latestAuditDiff('ai');
		const dStr = JSON.stringify(diff);
		expect(dStr).not.toContain('sk-ant-FAKE-FOR-TEST-1234567890ABC');
		expect(dStr).not.toContain('enc3:');
		expect(diff.apiKey).toEqual({ old: '••••••••', new: '••••••••' });
	});

	it('masks ai.apiKey on rotation too — both old and new', () => {
		updateSettingsSection('ai', { enabled: true, apiKey: 'sk-ant-INITIAL-VALUE-1234567890' }, 'audit-actor');
		updateSettingsSection('ai', { enabled: true, apiKey: 'sk-ant-ROTATED-VALUE-1234567890' }, 'audit-actor');
		const diff = latestAuditDiff('ai');
		const dStr = JSON.stringify(diff);
		expect(dStr).not.toContain('sk-ant-INITIAL-VALUE-1234567890');
		expect(dStr).not.toContain('sk-ant-ROTATED-VALUE-1234567890');
		// When the apiKey field is the only thing that changed, the diff
		// has it; when it didn't change (mask-preserved), the diff omits it.
		if (diff.apiKey) expect(diff.apiKey).toEqual({ old: '••••••••', new: '••••••••' });
	});

	it('masks rmm.updateManifestPrivateKey in the audit log diff', () => {
		// Direct write of a fabricated enc3: blob (we don't need a real keypair
		// for the masking assertion). The diff before our fix would have leaked
		// the ciphertext into the audit log on every rotation.
		updateSettingsSection('rmm', {
			defaultCheckinInterval: 60,
			updateManifestPrivateKey: 'enc3:fake-ciphertext-AAA',
			updateManifestPublicKey: 'pub-b64'
		} as Record<string, unknown>, 'audit-actor');
		updateSettingsSection('rmm', {
			defaultCheckinInterval: 60,
			updateManifestPrivateKey: 'enc3:fake-ciphertext-BBB',
			updateManifestPublicKey: 'pub-b64-rotated'
		} as Record<string, unknown>, 'audit-actor');
		const diff = latestAuditDiff('rmm');
		const dStr = JSON.stringify(diff);
		expect(dStr).not.toContain('enc3:fake-ciphertext-AAA');
		expect(dStr).not.toContain('enc3:fake-ciphertext-BBB');
		if (diff.updateManifestPrivateKey) {
			expect(diff.updateManifestPrivateKey).toEqual({ old: '••••••••', new: '••••••••' });
		}
	});
});

describe('getAllSettings — agent token pepper masking', () => {
	it('masks the stored pepper instead of shipping it to clients', async () => {
		const { setSetting } = await import('../../src/lib/server/db.js');
		const { getAllSettings } = await import('../../src/services/settings.js');
		setSetting('agentTokenPepper', 'pepper-must-not-leak-to-clients');
		const settings = getAllSettings() as Record<string, unknown>;
		expect(settings.agentTokenPepper).toBe('••••••••');
	});
});
