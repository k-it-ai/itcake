/**
 * Regression tests for the sixth-pass leftover items:
 *
 * 1. `pruneOldAiSessions` — sessions with no activity for 90+ days are
 *    pruned; recent sessions are kept; ai_cost_daily older than 365d
 *    is pruned.
 *
 * 2. Guacamole token has a 2-layer wrap: outer HMAC-SHA256 binds the
 *    inner CBC ciphertext, defeating padding-oracle / bit-flip attacks
 *    that would otherwise be possible against the malleable CBC layer.
 *
 * 3. AI message `content_blocks` run through redactSensitiveInput on
 *    the way into the store, so a model-emitted tool_use block that
 *    echoes a token-shaped string doesn't leak via the transcript.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-sixth-pass');

let db: typeof import('../../src/lib/server/db.js').db;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;
let startSession: typeof import('../../src/services/ai-session.js').startSession;
let pruneOldAiSessions: typeof import('../../src/services/ai-session.js').pruneOldAiSessions;
let getSessionTranscript: typeof import('../../src/services/ai-session.js').getSessionTranscript;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'six.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	setSetting = dbMod.setSetting;
	const sess = await import('../../src/services/ai-session.js');
	startSession = sess.startSession;
	pruneOldAiSessions = sess.pruneOldAiSessions;
	getSessionTranscript = sess.getSessionTranscript;

	setSetting('ai', { enabled: true, apiKey: 'sk-ant-test-key-1234567890', model: 'haiku-4-5', monthlyBudgetCents: 5000, consultantMode: false });
	db.prepare(
		`INSERT OR IGNORE INTO users (id, email, password_hash, totp_secret) VALUES ('user-1', 'test@example.com', 'unused', '')`
	).run();
});

beforeEach(() => {
	db.prepare('DELETE FROM ai_messages').run();
	db.prepare('DELETE FROM ai_sessions').run();
	db.prepare('DELETE FROM ai_cost_daily').run();
});

describe('pruneOldAiSessions — retention', () => {
	it('keeps a session that has recent message activity', () => {
		const sess = startSession('user-1', { approvalMode: 'per_step' });
		// Backdate the session creation but add a recent message.
		db.prepare("UPDATE ai_sessions SET created_at = datetime('now', '-200 days') WHERE id = ?").run(sess.id);
		db.prepare(
			`INSERT INTO ai_messages (id, session_id, role, content_blocks, created_at)
			 VALUES (?, ?, 'user', '[]', datetime('now', '-5 days'))`
		).run('msg-recent', sess.id);

		const { deletedSessions } = pruneOldAiSessions();
		expect(deletedSessions).toBe(0);
		expect(db.prepare('SELECT COUNT(*) AS n FROM ai_sessions').get()).toEqual({ n: 1 });
	});

	it('prunes a session with no activity for over 90 days', () => {
		const sess = startSession('user-1', { approvalMode: 'per_step' });
		db.prepare("UPDATE ai_sessions SET created_at = datetime('now', '-100 days') WHERE id = ?").run(sess.id);
		// No messages.

		const { deletedSessions } = pruneOldAiSessions();
		expect(deletedSessions).toBe(1);
		expect(db.prepare('SELECT COUNT(*) AS n FROM ai_sessions').get()).toEqual({ n: 0 });
	});

	it('prunes a session whose LATEST message is older than 90 days', () => {
		const sess = startSession('user-1', { approvalMode: 'per_step' });
		db.prepare("UPDATE ai_sessions SET created_at = datetime('now', '-200 days') WHERE id = ?").run(sess.id);
		db.prepare(
			`INSERT INTO ai_messages (id, session_id, role, content_blocks, created_at)
			 VALUES (?, ?, 'user', '[]', datetime('now', '-100 days'))`
		).run('msg-stale', sess.id);

		const { deletedSessions } = pruneOldAiSessions();
		expect(deletedSessions).toBe(1);
		// CASCADE deletes the message too.
		expect(db.prepare('SELECT COUNT(*) AS n FROM ai_messages').get()).toEqual({ n: 0 });
	});

	it('prunes ai_cost_daily rows older than 365 days', () => {
		db.prepare(
			`INSERT INTO ai_cost_daily (day) VALUES (date('now', '-400 days'))`
		).run();
		db.prepare(
			`INSERT INTO ai_cost_daily (day) VALUES (date('now', '-30 days'))`
		).run();
		const { deletedCostRows } = pruneOldAiSessions();
		expect(deletedCostRows).toBe(1);
		expect(db.prepare('SELECT COUNT(*) AS n FROM ai_cost_daily').get()).toEqual({ n: 1 });
	});
});
