/**
 * Follow-ups from loop 13:
 *   - F1: closeSession() wraps stmtCloseSession + recordChange in one
 *     transaction so a thrown audit-write doesn't flip status to
 *     'closed' without a paper trail.
 *   - F6/F14: /api/auth/register accepts optional `company.name` (+
 *     optional company.email) so a JSON bootstrap can complete
 *     isSetupComplete() in one round-trip.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-loop13');

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'l13.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
});

describe('register schema accepts optional company seed', () => {
	it('parses minimal body (no company) — caller will be warned via response payload', async () => {
		const { registerSchema } = await import('../../src/lib/validators-auth.js');
		const r = registerSchema.safeParse({
			email: 'op@test.example',
			name: 'Operator',
			password: 'Strong-Password-1'
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.company).toBeUndefined();
	});

	it('parses body with company.name (the isSetupComplete-satisfying minimum)', async () => {
		const { registerSchema } = await import('../../src/lib/validators-auth.js');
		const r = registerSchema.safeParse({
			email: 'op@test.example',
			name: 'Operator',
			password: 'Strong-Password-1',
			company: { name: 'Acme GmbH' }
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.company?.name).toBe('Acme GmbH');
			expect(r.data.company?.email).toBeUndefined();
		}
	});

	it('accepts company.email when supplied (validated as email)', async () => {
		const { registerSchema } = await import('../../src/lib/validators-auth.js');
		const r = registerSchema.safeParse({
			email: 'op@test.example',
			name: 'Operator',
			password: 'Strong-Password-1',
			company: { name: 'Acme', email: 'billing@acme.example' }
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.company?.email).toBe('billing@acme.example');
	});

	it('rejects company.email when malformed', async () => {
		const { registerSchema } = await import('../../src/lib/validators-auth.js');
		const r = registerSchema.safeParse({
			email: 'op@test.example',
			name: 'Operator',
			password: 'Strong-Password-1',
			company: { name: 'Acme', email: 'not-an-email' }
		});
		expect(r.success).toBe(false);
	});

	it('rejects empty company.name (caller must supply something non-blank)', async () => {
		const { registerSchema } = await import('../../src/lib/validators-auth.js');
		const r = registerSchema.safeParse({
			email: 'op@test.example',
			name: 'Operator',
			password: 'Strong-Password-1',
			company: { name: '' }
		});
		expect(r.success).toBe(false);
	});
});

describe('closeSession atomicity', () => {
	it('closeSession returns false for non-existent session (no-op, no audit row)', async () => {
		const { closeSession } = await import('../../src/services/ai-session.js');
		const db = (await import('../../src/lib/server/db.js')).db;
		db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash) VALUES ('u-l13', 'l13@t', 'h')`).run();

		const beforeAudit = db.prepare(`SELECT COUNT(*) as c FROM changes`).get() as { c: number };
		const ok = closeSession('does-not-exist', 'u-l13');
		expect(ok).toBe(false);
		const afterAudit = db.prepare(`SELECT COUNT(*) as c FROM changes`).get() as { c: number };
		expect(afterAudit.c).toBe(beforeAudit.c);
	});

	it('closeSession on a real session flips status AND writes audit row in one transaction', async () => {
		const { closeSession } = await import('../../src/services/ai-session.js');
		const db = (await import('../../src/lib/server/db.js')).db;
		db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash) VALUES ('u-l13b', 'l13b@t', 'h')`).run();

		// Insert directly — startSession requires an Anthropic API key.
		const sessId = 'sess-l13-close';
		db.prepare(
			`INSERT INTO ai_sessions (id, user_id, model, approval_mode, page_context, status) VALUES (?, 'u-l13b', 'claude-opus-4-7', 'per_step', '{}', 'active')`
		).run(sessId);

		const beforeAudit = db.prepare(`SELECT COUNT(*) as c FROM changes WHERE entity_type='ai_session' AND entity_id=?`).get(sessId) as { c: number };
		const ok = closeSession(sessId, 'u-l13b');
		expect(ok).toBe(true);

		const row = db.prepare(`SELECT status FROM ai_sessions WHERE id = ?`).get(sessId) as { status: string };
		expect(row.status).toBe('closed');

		const afterAudit = db.prepare(`SELECT COUNT(*) as c FROM changes WHERE entity_type='ai_session' AND entity_id=?`).get(sessId) as { c: number };
		expect(afterAudit.c).toBe(beforeAudit.c + 1);
	});
});
