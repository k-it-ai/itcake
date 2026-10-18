/**
 * Regression for security-review finding #2 (High):
 *   `replaceTables` in `restoreBackup` previously omitted eight tables that
 *   the backup snapshot covers — `agent_findings`, `agent_collector_results`,
 *   `ai_sessions`, `ai_messages`, `ai_tool_executions`, `ai_cost_daily`,
 *   `backup_verifications`, `recovery_readiness`. With FKs off during restore,
 *   the omission left orphan rows pointing at users/agents that no longer
 *   existed after the restore. This test creates rows in each of those
 *   tables, snapshots them into a backup, mutates the live DB out of sync,
 *   restores, and verifies every table matches the backup-time state.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-restore-replace');

let db: typeof import('../../src/lib/server/db.js').db;
let getSetting: typeof import('../../src/lib/server/db.js').getSetting;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;
let createBackup: typeof import('../../src/services/backups.js').createBackup;
let restoreBackup: typeof import('../../src/services/backups.js').restoreBackup;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'restore.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	getSetting = dbMod.getSetting;
	setSetting = dbMod.setSetting;
	// `rate_limits` table is created lazily by rate-limit.ts module load;
	// `restoreBackup` unconditionally `DELETE`s from it. Import it now so
	// the table exists before any restore tx runs.
	await import('../../src/lib/server/rate-limit.js');
	const bk = await import('../../src/services/backups.js');
	createBackup = bk.createBackup;
	restoreBackup = bk.restoreBackup;
});

function seedUserAndAgent(userId: string, agentId: string): void {
	db.prepare('INSERT OR REPLACE INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(userId, `${userId}@t`, 'h');
	db.prepare(
		`INSERT OR REPLACE INTO agents (id, name, hostname, os, arch, token_hash, status, enabled, data)
		 VALUES (?, 'a', 'h', 'linux', 'amd64', ?, 'online', 1, '{}')`
	).run(agentId, `tok-${agentId}`);
}

describe('restoreBackup replaceTables — finding #2 regression', () => {
	it('restores agent_findings rows from the backup, dropping post-backup rows', async () => {
		seedUserAndAgent('u-snapshot', 'agent-snapshot');
		db.prepare("DELETE FROM agent_findings WHERE agent_id = 'agent-snapshot'").run();
		db.prepare(
			`INSERT INTO agent_findings (id, agent_id, category, severity, title, fingerprint, state)
			 VALUES (?, ?, 'policy', 'low', 'snapshot-finding', 'fp-snap', 'open')`
		).run('find-snap', 'agent-snapshot');

		const info = await createBackup();

		// Mutate live DB out of sync: drop snapshot row, add a post-snapshot row.
		db.prepare("DELETE FROM agent_findings WHERE id = 'find-snap'").run();
		db.prepare(
			`INSERT INTO agent_findings (id, agent_id, category, severity, title, fingerprint, state)
			 VALUES (?, ?, 'policy', 'high', 'post-snapshot-finding', 'fp-post', 'open')`
		).run('find-post', 'agent-snapshot');

		await restoreBackup(info.filename);

		const snap = db.prepare('SELECT id, title FROM agent_findings WHERE id = ?').get('find-snap') as { id: string; title: string } | undefined;
		const post = db.prepare('SELECT id FROM agent_findings WHERE id = ?').get('find-post');
		expect(snap?.title).toBe('snapshot-finding');
		expect(post).toBeUndefined();
	});

	it('restores agent_collector_results from the backup, dropping post-backup rows', async () => {
		seedUserAndAgent('u-collector', 'agent-collector');
		db.prepare("DELETE FROM agent_collector_results WHERE agent_id = 'agent-collector'").run();
		db.prepare(
			`INSERT INTO agent_collector_results (id, agent_id, kind, payload)
			 VALUES (?, ?, 'reliability_daily', '{"snap":true}')`
		).run('coll-snap', 'agent-collector');

		const info = await createBackup();
		db.prepare("DELETE FROM agent_collector_results WHERE id = 'coll-snap'").run();
		db.prepare(
			`INSERT INTO agent_collector_results (id, agent_id, kind, payload)
			 VALUES (?, ?, 'reliability_daily', '{"post":true}')`
		).run('coll-post', 'agent-collector');

		await restoreBackup(info.filename);

		const snap = db.prepare('SELECT id, payload FROM agent_collector_results WHERE id = ?').get('coll-snap') as { payload: string } | undefined;
		const post = db.prepare('SELECT id FROM agent_collector_results WHERE id = ?').get('coll-post');
		expect(snap?.payload).toContain('"snap":true');
		expect(post).toBeUndefined();
	});

	it('restores ai_sessions / ai_messages / ai_tool_executions / ai_cost_daily', async () => {
		seedUserAndAgent('u-ai', 'agent-ai');
		db.prepare("DELETE FROM ai_sessions WHERE id LIKE 'ai-%'").run();
		db.prepare("DELETE FROM ai_cost_daily WHERE day LIKE '2026-04-%'").run();

		db.prepare(
			`INSERT INTO ai_sessions (id, user_id, title, model) VALUES (?, ?, ?, ?)`
		).run('ai-snap', 'u-ai', 'snap-session', 'claude-opus-4-7');
		db.prepare(
			`INSERT INTO ai_messages (id, session_id, role, content_blocks) VALUES (?, ?, 'user', '[]')`
		).run('msg-snap', 'ai-snap');
		db.prepare(
			`INSERT INTO ai_tool_executions (id, session_id, tool_name, tier, status) VALUES (?, ?, 'list_agents', 1, 'auto')`
		).run('exec-snap', 'ai-snap');
		db.prepare(
			`INSERT INTO ai_cost_daily (day, input_tokens, output_tokens, cost_cents) VALUES ('2026-04-15', 100, 50, 1)`
		).run();

		const info = await createBackup();

		// Mutate.
		db.prepare("DELETE FROM ai_sessions WHERE id = 'ai-snap'").run(); // cascades msg + exec
		db.prepare(
			`INSERT INTO ai_sessions (id, user_id, title, model) VALUES (?, ?, ?, ?)`
		).run('ai-post', 'u-ai', 'post-session', 'claude-opus-4-7');
		db.prepare("UPDATE ai_cost_daily SET cost_cents = 999 WHERE day = '2026-04-15'").run();

		await restoreBackup(info.filename);

		const snap = db.prepare('SELECT title FROM ai_sessions WHERE id = ?').get('ai-snap') as { title: string } | undefined;
		expect(snap?.title).toBe('snap-session');
		const post = db.prepare("SELECT id FROM ai_sessions WHERE id = 'ai-post'").get();
		expect(post).toBeUndefined();

		const msg = db.prepare("SELECT id FROM ai_messages WHERE id = 'msg-snap'").get();
		expect(msg).toBeDefined();
		const exec = db.prepare("SELECT id FROM ai_tool_executions WHERE id = 'exec-snap'").get();
		expect(exec).toBeDefined();
		const cost = db.prepare("SELECT cost_cents FROM ai_cost_daily WHERE day = '2026-04-15'").get() as { cost_cents: number };
		expect(cost.cost_cents).toBe(1);
	});

	it('restores backup_verifications and recovery_readiness rows', async () => {
		db.prepare("DELETE FROM backup_verifications WHERE id LIKE 'verif-%'").run();
		db.prepare(
			`INSERT INTO backup_verifications (id, filename, type, status, started_at)
			 VALUES (?, 'backup-2026-01-01-000000.zip', 'integrity', 'passed', datetime('now'))`
		).run('verif-snap');
		db.prepare(
			`UPDATE recovery_readiness SET score = 88, risk_factors = '[]', updated_at = datetime('now') WHERE id = 1`
		).run();

		const info = await createBackup();

		db.prepare("DELETE FROM backup_verifications WHERE id = 'verif-snap'").run();
		db.prepare(
			`INSERT INTO backup_verifications (id, filename, type, status, started_at)
			 VALUES (?, 'backup-2026-02-02-000000.zip', 'integrity', 'failed', datetime('now'))`
		).run('verif-post');
		db.prepare(`UPDATE recovery_readiness SET score = 0 WHERE id = 1`).run();

		await restoreBackup(info.filename);

		const snap = db.prepare("SELECT id FROM backup_verifications WHERE id = 'verif-snap'").get();
		const post = db.prepare("SELECT id FROM backup_verifications WHERE id = 'verif-post'").get();
		expect(snap).toBeDefined();
		expect(post).toBeUndefined();
		const readiness = db.prepare('SELECT score FROM recovery_readiness WHERE id = 1').get() as { score: number };
		expect(readiness.score).toBe(88);
	});

	it('drops memoised settings so restored values are not shadowed by cache', async () => {
		setSetting('company', { name: 'Backup-Company' });
		expect(getSetting<{ name: string }>('company').name).toBe('Backup-Company');

		const info = await createBackup();

		setSetting('company', { name: 'Post-Backup-Company' });
		expect(getSetting<{ name: string }>('company').name).toBe('Post-Backup-Company');

		await restoreBackup(info.filename);

		// Without the post-restore cache clear this returns the post-backup
		// value while the DB already holds the snapshot value.
		expect(getSetting<{ name: string }>('company').name).toBe('Backup-Company');
	});
});
