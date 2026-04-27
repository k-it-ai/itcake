import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Hash-chain integrity test — requires a disposable DB since it writes
// rows. Uses the same on-disk SQLite pattern as the integration suite.
const TEST_DIR = path.resolve('data-test-audit');

let recordChange: typeof import('../../src/lib/server/changes.js').recordChange;
let verifyAuditLogIntegrity: typeof import('../../src/lib/server/changes.js').verifyAuditLogIntegrity;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'audit.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	// Dynamic import AFTER env is seeded.
	const dbMod = await import('../../src/lib/server/db.js');
	const ch = await import('../../src/lib/server/changes.js');
	db = dbMod.db;
	recordChange = ch.recordChange;
	verifyAuditLogIntegrity = ch.verifyAuditLogIntegrity;

	// Clear any rows a previous run might have left (we recreated the dir,
	// but the DB file is new — this is a belt.)
	db.prepare('DELETE FROM changes').run();
});

describe('audit log hash chain', () => {
	it('records entries with a non-empty chained hash', () => {
		recordChange('invoice', 'inv-1', 'create', {}, 'u1');
		recordChange('invoice', 'inv-1', 'update', { foo: { old: 'a', new: 'b' } }, 'u1');

		const rows = db.prepare('SELECT id, hash FROM changes ORDER BY created_at ASC').all() as { id: string; hash: string }[];
		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const r of rows) {
			expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it('verifies the chain when untampered', () => {
		const result = verifyAuditLogIntegrity();
		expect(result.total).toBeGreaterThan(0);
		expect(result.tamperedIds).toEqual([]);
	});

	it('detects tampering: modified diff', () => {
		// Grab a row and modify its diff directly. The stored hash no longer
		// matches the recomputed hash over the new fields → reported.
		const row = db.prepare('SELECT id FROM changes ORDER BY created_at ASC LIMIT 1').get() as { id: string };
		db.prepare("UPDATE changes SET diff = ? WHERE id = ?").run('{"hacked":{"old":0,"new":1}}', row.id);

		const result = verifyAuditLogIntegrity();
		expect(result.tamperedIds).toContain(row.id);

		// Restore so subsequent tests in the same run aren't polluted.
		db.prepare("UPDATE changes SET diff = '{}' WHERE id = ?").run(row.id);
	});

	it('detects tampering: inserted row with forged hash', () => {
		// Insert a row that mimics the chain format but uses an invented hash.
		// Integrity check must flag it — this is the threat model: someone
		// with DB write access cannot slip in a fake entry without the
		// SESSION_SECRET key.
		const id = 'evil-row';
		const forged = 'f'.repeat(64);
		db.prepare(
			"INSERT INTO changes (id, entity_type, entity_id, action, diff, user_id, created_at, hash) VALUES (?, 'invoice', 'fake', 'delete', '{}', 'attacker', ?, ?)"
		).run(id, new Date(Date.now() + 1000).toISOString(), forged);

		const result = verifyAuditLogIntegrity();
		expect(result.tamperedIds).toContain(id);

		// Clean up
		db.prepare('DELETE FROM changes WHERE id = ?').run(id);
	});

	it('detects tampering: row deletion (chain discontinuity)', () => {
		// Deleting a middle row breaks the chain because successor.prev_hash
		// no longer matches. The successor's hash was computed against the
		// now-missing predecessor, so when we recompute it from the new
		// predecessor, it mismatches.
		recordChange('invoice', 'inv-del', 'create', {}, 'u1');
		recordChange('invoice', 'inv-del', 'update', { x: { old: 1, new: 2 } }, 'u1');
		recordChange('invoice', 'inv-del', 'status_change', { s: { old: 'draft', new: 'sent' } }, 'u1');

		// Find the MIDDLE row (the update) and delete it.
		const rows = db.prepare("SELECT id, action FROM changes WHERE entity_id = 'inv-del' ORDER BY created_at ASC").all() as { id: string; action: string }[];
		const middle = rows.find(r => r.action === 'update');
		expect(middle).toBeTruthy();
		db.prepare('DELETE FROM changes WHERE id = ?').run(middle!.id);

		const result = verifyAuditLogIntegrity();
		// The successor of the deleted row must now fail verification.
		const successor = rows.find(r => r.action === 'status_change')!;
		expect(result.tamperedIds).toContain(successor.id);
	});

	it('detects tamper-downgrade via hash clearing (B3)', () => {
		// Threat model: an attacker with DB write access tampers with a
		// row, the verifier flags it tampered. To mask the tamper, the
		// attacker clears the row's hash to convert it from "tampered"
		// into "legacy unverified" (which the verifier silently skipped
		// before this fix). Once the chain has been established (any
		// hash-bearing row has been seen), an empty hash MUST count as
		// tampered, not unverified.
		// Wipe ALL prior chain state so the new rows start a clean chain.
		// Earlier tests in this file leave sentinel rows behind on
		// purpose (broken-chain assertions don't clean up); without a
		// blanket truncate the verifier walks them too and reports
		// mid-chain tampers we don't care about here.
		db.prepare('DELETE FROM changes').run();
		recordChange('invoice', 'inv-A', 'create', {}, 'u1');
		recordChange('invoice', 'inv-A', 'update', { x: { old: 1, new: 2 } }, 'u1');

		// Confirm baseline clean.
		expect(verifyAuditLogIntegrity().tamperedIds).toEqual([]);

		// Clear the second row's hash — would have been "unverified" under
		// the old verifier, hiding any prior tamper of this row.
		const rows = db.prepare("SELECT id FROM changes WHERE entity_id = 'inv-A' ORDER BY created_at ASC").all() as { id: string }[];
		db.prepare("UPDATE changes SET hash = '' WHERE id = ?").run(rows[1].id);

		const result = verifyAuditLogIntegrity();
		expect(result.tamperedIds).toContain(rows[1].id);
	});
});
