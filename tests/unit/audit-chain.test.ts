import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-audit');

let recordChange: typeof import('../../src/lib/server/changes.js').recordChange;
let verifyAuditLogIntegrity: typeof import('../../src/lib/server/changes.js').verifyAuditLogIntegrity;
let snapshotAuditAnchor: typeof import('../../src/lib/server/changes.js').snapshotAuditAnchor;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'audit.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const ch = await import('../../src/lib/server/changes.js');
	db = dbMod.db;
	recordChange = ch.recordChange;
	verifyAuditLogIntegrity = ch.verifyAuditLogIntegrity;
	snapshotAuditAnchor = ch.snapshotAuditAnchor;

	resetChain();
});

function resetChain() {
	db.prepare('DELETE FROM changes').run();
	db.prepare("UPDATE audit_anchor SET row_count = 0, last_hash = '', anchor_hmac = '', updated_at = '' WHERE id = 1").run();
	db.prepare('DELETE FROM audit_anchor_history').run();
}

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
		const row = db.prepare('SELECT id FROM changes ORDER BY created_at ASC LIMIT 1').get() as { id: string };
		db.prepare("UPDATE changes SET diff = ? WHERE id = ?").run('{"hacked":{"old":0,"new":1}}', row.id);

		const result = verifyAuditLogIntegrity();
		expect(result.tamperedIds).toContain(row.id);

		db.prepare("UPDATE changes SET diff = '{}' WHERE id = ?").run(row.id);
	});

	it('detects tampering: inserted row with forged hash', () => {
		// Integrity check must flag it — this is the threat model: someone
		const id = 'evil-row';
		const forged = 'f'.repeat(64);
		db.prepare(
			"INSERT INTO changes (id, entity_type, entity_id, action, diff, user_id, created_at, hash) VALUES (?, 'invoice', 'fake', 'delete', '{}', 'attacker', ?, ?)"
		).run(id, new Date(Date.now() + 1000).toISOString(), forged);

		const result = verifyAuditLogIntegrity();
		expect(result.tamperedIds).toContain(id);

		db.prepare('DELETE FROM changes WHERE id = ?').run(id);
	});

	it('detects tampering: row deletion (chain discontinuity)', () => {
		recordChange('invoice', 'inv-del', 'create', {}, 'u1');
		recordChange('invoice', 'inv-del', 'update', { x: { old: 1, new: 2 } }, 'u1');
		recordChange('invoice', 'inv-del', 'status_change', { s: { old: 'draft', new: 'sent' } }, 'u1');

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
		// hash-bearing row has been seen), an empty hash MUST count as
		resetChain();
		recordChange('invoice', 'inv-A', 'create', {}, 'u1');
		recordChange('invoice', 'inv-A', 'update', { x: { old: 1, new: 2 } }, 'u1');

		expect(verifyAuditLogIntegrity().tamperedIds).toEqual([]);

		const rows = db.prepare("SELECT id FROM changes WHERE entity_id = 'inv-A' ORDER BY created_at ASC, rowid ASC").all() as { id: string }[];
		db.prepare("UPDATE changes SET hash = '' WHERE id = ?").run(rows[1].id);

		const result = verifyAuditLogIntegrity();
		expect(result.tamperedIds).toContain(rows[1].id);
	});

	it('verifier accepts v0 (legacy |-separated) hashes — backward compat (B4)', async () => {
		// separated chain hashes. The verifier MUST accept them without
		resetChain();

		const crypto = await import('node:crypto');
		const secret = process.env.SESSION_SECRET!;
		const id = 'legacy-v0-row';
		const entityType = 'invoice';
		const entityId = 'inv-legacy';
		const action = 'create';
		const diff = '{}';
		const userId = 'u1';
		const createdAt = '2024-01-01T00:00:00.000Z';
		const v0Msg = `|${id}|${entityType}|${entityId}|${action}|${diff}|${userId}|${createdAt}`;
		const v0Hash = crypto.createHmac('sha256', secret).update(v0Msg).digest('hex');

		db.prepare(
			'INSERT INTO changes (id, entity_type, entity_id, action, diff, user_id, created_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		).run(id, entityType, entityId, action, diff, userId, createdAt, v0Hash);

		const result = verifyAuditLogIntegrity();
		expect(result.tamperedIds).not.toContain(id);
		expect(result.verified).toBeGreaterThanOrEqual(1);

		recordChange('invoice', 'inv-legacy', 'update', { x: { old: 1, new: 2 } }, 'u1');
		const result2 = verifyAuditLogIntegrity();
		expect(result2.tamperedIds).toEqual([]);
	});
});

describe('audit anchor (tail-truncation guard)', () => {
	it('reports anchor=ok after a normal recordChange', () => {
		resetChain();
		recordChange('invoice', 'inv-A1', 'create', {}, 'u1');
		recordChange('invoice', 'inv-A1', 'update', { foo: { old: 1, new: 2 } }, 'u1');
		const result = verifyAuditLogIntegrity();
		expect(result.anchor).toBe('ok');
		expect(result.tamperedIds).toEqual([]);
	});

	it('detects tail-truncation: row deleted at the end without anchor update', () => {
		resetChain();
		recordChange('invoice', 'inv-T1', 'create', {}, 'u1');
		recordChange('invoice', 'inv-T1', 'update', { foo: { old: 1, new: 2 } }, 'u1');
		recordChange('invoice', 'inv-T1', 'status_change', { s: { old: 'draft', new: 'sent' } }, 'u1');
		expect(verifyAuditLogIntegrity().anchor).toBe('ok');

		const last = db.prepare("SELECT id FROM changes ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string };
		db.prepare('DELETE FROM changes WHERE id = ?').run(last.id);
		const result = verifyAuditLogIntegrity();
		expect(result.anchor).toBe('tail-truncated');
	});

	it('detects anchor mismatch when an attacker zeroes the anchor row', () => {
		resetChain();
		recordChange('invoice', 'inv-M1', 'create', {}, 'u1');
		expect(verifyAuditLogIntegrity().anchor).toBe('ok');

		db.prepare("UPDATE audit_anchor SET anchor_hmac = 'deadbeef' WHERE id = 1").run();
		const result = verifyAuditLogIntegrity();
		expect(result.anchor).toBe('mismatch');
	});

	it('reports anchor=none on a never-anchored DB (legacy install)', () => {
		resetChain();
		const result = verifyAuditLogIntegrity();
		expect(result.anchor).toBe('none');
	});

	it('detects anchor-reset bypass: rows present + anchor cleared → mismatch (not none)', () => {
		resetChain();
		recordChange('invoice', 'inv-R1', 'create', {}, 'u1');
		recordChange('invoice', 'inv-R2', 'create', {}, 'u1');
		expect(verifyAuditLogIntegrity().anchor).toBe('ok');

		// Attacker truncates the tail AND resets the anchor row to fake a
		// "never-anchored DB" state.
		db.prepare("DELETE FROM changes WHERE entity_id = 'inv-R2'").run();
		db.prepare("UPDATE audit_anchor SET row_count = 0, last_hash = '', anchor_hmac = '', updated_at = '' WHERE id = 1").run();

		const r = verifyAuditLogIntegrity();
		expect(r.anchor).toBe('mismatch');
		expect(r.total).toBe(1); // chain still has inv-R1
	});

	it('does not let DELETE-many-then-prefix-rebuild slip past', () => {
		resetChain();
		recordChange('invoice', 'inv-B1', 'create', {}, 'u1');
		recordChange('invoice', 'inv-B2', 'create', {}, 'u1');
		recordChange('invoice', 'inv-B3', 'create', {}, 'u1');
		expect(verifyAuditLogIntegrity().anchor).toBe('ok');

		db.prepare("DELETE FROM changes WHERE entity_id IN ('inv-B2', 'inv-B3')").run();
		const r = verifyAuditLogIntegrity();
		expect(r.anchor).toBe('tail-truncated');
	});
});

describe('audit_anchor_history (retroactive truncation forensics)', () => {
	it('snapshot inserts a row when anchor state has changed', () => {
		resetChain();
		recordChange('invoice', 'inv-H1', 'create', {}, 'u1');
		const inserted = snapshotAuditAnchor();
		expect(inserted).toBe(true);
		const rows = db.prepare('SELECT row_count, last_hash, anchor_hmac FROM audit_anchor_history').all() as Array<{ row_count: number; last_hash: string; anchor_hmac: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].row_count).toBe(1);
		expect(rows[0].anchor_hmac).toMatch(/^[0-9a-f]{64}$/);
	});

	it('snapshot is idempotent for unchanged anchor state', () => {
		resetChain();
		recordChange('invoice', 'inv-H2', 'create', {}, 'u1');
		expect(snapshotAuditAnchor()).toBe(true);
		expect(snapshotAuditAnchor()).toBe(false);
		expect(snapshotAuditAnchor()).toBe(false);
		const count = (db.prepare('SELECT COUNT(*) as c FROM audit_anchor_history').get() as { c: number }).c;
		expect(count).toBe(1);
	});

	it('snapshot inserts a new row after the chain advances', () => {
		resetChain();
		recordChange('invoice', 'inv-H3', 'create', {}, 'u1');
		expect(snapshotAuditAnchor()).toBe(true);

		recordChange('invoice', 'inv-H3', 'update', { x: { old: 1, new: 2 } }, 'u1');
		expect(snapshotAuditAnchor()).toBe(true);

		const count = (db.prepare('SELECT COUNT(*) as c FROM audit_anchor_history').get() as { c: number }).c;
		expect(count).toBe(2);
	});

	it('snapshot prunes old rows beyond the 365 limit', () => {
		resetChain();
		const stmt = db.prepare('INSERT INTO audit_anchor_history (row_count, last_hash, anchor_hmac, captured_at) VALUES (?, ?, ?, ?)');
		for (let i = 0; i < 400; i++) {
			stmt.run(i, 'h'.repeat(64), 'a'.repeat(64), `2026-${String(((i % 12) + 1)).padStart(2, '0')}-01T00:00:00Z`);
		}
		expect((db.prepare('SELECT COUNT(*) as c FROM audit_anchor_history').get() as { c: number }).c).toBe(400);

		recordChange('invoice', 'inv-H4', 'create', {}, 'u1');
		expect(snapshotAuditAnchor()).toBe(true);

		const after = (db.prepare('SELECT COUNT(*) as c FROM audit_anchor_history').get() as { c: number }).c;
		expect(after).toBe(365);
	});

	it('verify reports historyMaxRowCount and historyTruncationDetected=false on a healthy chain', () => {
		resetChain();
		recordChange('invoice', 'inv-H5', 'create', {}, 'u1');
		recordChange('invoice', 'inv-H5', 'update', { x: { old: 1, new: 2 } }, 'u1');
		snapshotAuditAnchor();

		const r = verifyAuditLogIntegrity();
		expect(r.historyMaxRowCount).toBe(2);
		expect(r.historyTruncationDetected).toBe(false);
		expect(r.anchor).toBe('ok');
	});

	it('detects retroactive truncation: history row_count > current total', () => {
		resetChain();
		recordChange('invoice', 'inv-H6', 'create', {}, 'u1');
		recordChange('invoice', 'inv-H6', 'update', { x: { old: 1, new: 2 } }, 'u1');
		recordChange('invoice', 'inv-H6', 'status_change', { s: { old: 'draft', new: 'sent' } }, 'u1');
		expect(snapshotAuditAnchor()).toBe(true);

		db.prepare("DELETE FROM changes WHERE entity_id = 'inv-H6'").run();
		db.prepare("UPDATE audit_anchor SET row_count = 0, last_hash = '', anchor_hmac = '', updated_at = '' WHERE id = 1").run();

		const r = verifyAuditLogIntegrity();
		expect(r.historyMaxRowCount).toBe(3);
		expect(r.historyTruncationDetected).toBe(true);
	});

	it('ignores history rows whose anchor_hmac does not verify (defense against forged history)', () => {
		resetChain();
		db.prepare(
			'INSERT INTO audit_anchor_history (row_count, last_hash, anchor_hmac, captured_at) VALUES (?, ?, ?, ?)'
		).run(9999, 'h'.repeat(64), 'f'.repeat(64), '2026-01-01T00:00:00.000Z');

		const r = verifyAuditLogIntegrity();
		expect(r.historyTruncationDetected).toBe(false);
		expect(r.historyMaxRowCount).toBe(9999);
	});
});
