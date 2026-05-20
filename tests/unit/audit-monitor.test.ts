import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-audit-monitor');

let runScheduledAuditIntegrityCheck: typeof import('../../src/services/audit-monitor.js').runScheduledAuditIntegrityCheck;
let getAuditIntegrityStatus: typeof import('../../src/services/audit-monitor.js').getAuditIntegrityStatus;
let db: typeof import('../../src/lib/server/db.js').db;
let recordChange: typeof import('../../src/lib/server/changes.js').recordChange;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'am.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	const changes = await import('../../src/lib/server/changes.js');
	recordChange = changes.recordChange;
	const am = await import('../../src/services/audit-monitor.js');
	runScheduledAuditIntegrityCheck = am.runScheduledAuditIntegrityCheck;
	getAuditIntegrityStatus = am.getAuditIntegrityStatus;

	db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash) VALUES ('u-1', 'u@test', 'h')").run();
});

describe('runScheduledAuditIntegrityCheck', () => {
	it('persists last-checked-at + anchor + verified/total counts', () => {
		recordChange('agent', 'a-1', 'create', {}, 'u-1');
		recordChange('agent', 'a-1', 'update', { x: { old: 1, new: 2 } }, 'u-1');

		const before = getAuditIntegrityStatus();
		expect(before.lastCheckedAt).toBeNull();

		const after = runScheduledAuditIntegrityCheck();
		expect(after.lastCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(after.total).toBeGreaterThanOrEqual(2);
		expect(after.verified).toBeGreaterThanOrEqual(2);
		expect(after.tamperedCount).toBe(0);
		expect(after.anchorState).toBe('ok');
	});

	it('flags tampered_count > 0 when a row hash is mutated', () => {
		const before = getAuditIntegrityStatus();
		expect(before.tamperedCount).toBe(0);

		// Tamper: zero the hash on the most recent changes row so the chain
		// no longer verifies for that entry.
		db.prepare("UPDATE changes SET hash = 'deadbeef' WHERE id IN (SELECT id FROM changes ORDER BY created_at DESC LIMIT 1)").run();

		const after = runScheduledAuditIntegrityCheck();
		expect(after.tamperedCount).toBeGreaterThanOrEqual(1);
	});
});
