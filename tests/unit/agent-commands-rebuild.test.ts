/**
 * Regression: the agent_commands CHECK-list rebuild copied rows with
 * `SELECT *` into a template that predated `nack_count`, so booting any
 * database whose CHECK list was older died with "16 values for 15 columns"
 * — the server could not start until the DB was repaired by hand.
 *
 * The two cases share one database file and run in order.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const TEST_DIR = path.resolve('data-test-agent-commands-rebuild');
const DB_PATH = path.join(TEST_DIR, 'old-check.db');

/** Replaces agent_commands with a table whose CHECK list predates later command types. */
function swapTable(withNackCount: boolean): void {
	const nackCol = withNackCount ? ',\n\t\t\tnack_count INTEGER NOT NULL DEFAULT 0' : '';
	const cols = 'id, agent_id, type, payload, signature, status, issued_at, started_at, completed_at, exit_code, stdout, stderr, timeout_seconds, user_id, created_at';
	const selectCols = withNackCount ? `${cols}, nack_count` : cols;

	const raw = new Database(DB_PATH);
	raw.pragma('foreign_keys = OFF');
	raw.exec(`
		DROP TABLE IF EXISTS agent_commands_old;
		CREATE TABLE agent_commands_old (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			type TEXT NOT NULL CHECK (type IN ('shell', 'script')),
			payload TEXT NOT NULL DEFAULT '{}',
			signature TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending',
			issued_at TEXT NOT NULL DEFAULT (datetime('now')),
			started_at TEXT,
			completed_at TEXT,
			exit_code INTEGER,
			stdout TEXT NOT NULL DEFAULT '',
			stderr TEXT NOT NULL DEFAULT '',
			timeout_seconds INTEGER NOT NULL DEFAULT 300,
			user_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))${nackCol}
		);
		INSERT INTO agent_commands_old (${selectCols}) SELECT ${selectCols} FROM agent_commands;
		DROP TABLE agent_commands;
		ALTER TABLE agent_commands_old RENAME TO agent_commands;
	`);
	raw.close();
}

beforeAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATA_DIR = TEST_DIR;
	process.env.DATABASE_PATH = DB_PATH;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
});

describe('db boot — agent_commands CHECK-list rebuild', () => {
	it('boots, keeps rows and preserves nack_count when the live table has it', async () => {
		const first = await import('../../src/lib/server/db.js');
		first.db.prepare("INSERT INTO agents (id, name, token_hash) VALUES ('a-1', 'host', 'tok-1')").run();
		first.db.prepare("INSERT INTO agent_commands (id, agent_id, type, user_id, nack_count, status) VALUES ('cmd-1', 'a-1', 'shell', 'u-1', 3, 'failed')").run();
		first.db.close();

		swapTable(true);

		vi.resetModules();
		const { db } = await import('../../src/lib/server/db.js');

		const row = db.prepare("SELECT status, nack_count FROM agent_commands WHERE id = 'cmd-1'").get() as { status: string; nack_count: number };
		expect(row.status).toBe('failed');
		expect(row.nack_count).toBe(3);

		const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_commands'").get() as { sql: string }).sql;
		expect(sql).toContain("'cis_audit'");
		expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_commands_new'").get()).toBeUndefined();
	});

	it('backfills nack_count when the live table predates the column', async () => {
		swapTable(false);

		vi.resetModules();
		const { db } = await import('../../src/lib/server/db.js');

		const row = db.prepare("SELECT status, nack_count FROM agent_commands WHERE id = 'cmd-1'").get() as { status: string; nack_count: number };
		expect(row.status).toBe('failed');
		expect(row.nack_count).toBe(0);

		const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_commands'").get() as { sql: string }).sql;
		expect(sql).toContain("'cis_audit'");
		expect(sql).toContain('nack_count');
	});
});
