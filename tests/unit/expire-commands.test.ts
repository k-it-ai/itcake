import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-expire-commands');

let db: typeof import('../../src/lib/server/db.js').db;
let expirePendingCommands: typeof import('../../src/services/agent-commands.js').expirePendingCommands;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'expire.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const cmdMod = await import('../../src/services/agent-commands.js');
	db = dbMod.db;
	expirePendingCommands = cmdMod.expirePendingCommands;
});

function seedCommand(id: string, opts: {
	status: 'pending' | 'running' | 'completed' | 'expired';
	issuedAtSqlExpr: string;
	startedAtSqlExpr?: string | null;
	timeoutSeconds: number;
}): void {
	const startedAt = opts.startedAtSqlExpr ?? 'NULL';
	db.prepare(
		`INSERT INTO agent_commands (id, agent_id, type, payload, signature, status, issued_at, started_at, timeout_seconds, user_id) ` +
		`VALUES (?, 'agent-x', 'shell', '{}', 'sig', ?, ${opts.issuedAtSqlExpr}, ${startedAt}, ?, 'user')`
	).run(id, opts.status, opts.timeoutSeconds);
}

function statusOf(id: string): string {
	const row = db.prepare('SELECT status FROM agent_commands WHERE id = ?').get(id) as { status: string } | undefined;
	return row?.status ?? '(missing)';
}

describe('expirePendingCommands', () => {
	beforeAll(() => {
		db.prepare("DELETE FROM agent_commands WHERE agent_id = 'agent-x'").run();
		db.prepare("DELETE FROM agents WHERE id = 'agent-x'").run();
		db.prepare("INSERT INTO agents (id, name, hostname, os, arch, token_hash, data) VALUES ('agent-x', 'x', 'x', 'linux', 'amd64', 'h', '{}')").run();
	});

	it('expires a pending command whose issued_at + timeout has elapsed', () => {
		seedCommand('exp-pending-old', {
			status: 'pending',
			issuedAtSqlExpr: "datetime('now', '-3600 seconds')",
			timeoutSeconds: 60
		});
		expirePendingCommands();
		expect(statusOf('exp-pending-old')).toBe('expired');
	});

	it('keeps a pending command that is still within its timeout window', () => {
		seedCommand('exp-pending-fresh', {
			status: 'pending',
			issuedAtSqlExpr: "datetime('now', '-10 seconds')",
			timeoutSeconds: 300
		});
		expirePendingCommands();
		expect(statusOf('exp-pending-fresh')).toBe('pending');
	});

	it('expires a stuck running command whose started_at + timeout + 60s grace has elapsed', () => {
		seedCommand('exp-running-old', {
			status: 'running',
			issuedAtSqlExpr: "datetime('now', '-3600 seconds')",
			startedAtSqlExpr: "datetime('now', '-3600 seconds')",
			timeoutSeconds: 60
		});
		expirePendingCommands();
		expect(statusOf('exp-running-old')).toBe('expired');
	});

	it('keeps a running command that is still within its (timeout + 60s grace) window', () => {
		seedCommand('exp-running-fresh', {
			status: 'running',
			issuedAtSqlExpr: "datetime('now', '-30 seconds')",
			startedAtSqlExpr: "datetime('now', '-30 seconds')",
			timeoutSeconds: 300
		});
		expirePendingCommands();
		expect(statusOf('exp-running-fresh')).toBe('running');
	});

	it('does not touch completed or already-expired commands', () => {
		seedCommand('exp-completed', {
			status: 'completed',
			issuedAtSqlExpr: "datetime('now', '-3600 seconds')",
			startedAtSqlExpr: "datetime('now', '-3600 seconds')",
			timeoutSeconds: 60
		});
		seedCommand('exp-already-expired', {
			status: 'expired',
			issuedAtSqlExpr: "datetime('now', '-3600 seconds')",
			timeoutSeconds: 60
		});
		expirePendingCommands();
		expect(statusOf('exp-completed')).toBe('completed');
		expect(statusOf('exp-already-expired')).toBe('expired');
	});

	it('honors per-row timeout_seconds — a 30-min schedule is not expired by a 60s default', () => {
		seedCommand('exp-long-timeout', {
			status: 'pending',
			issuedAtSqlExpr: "datetime('now', '-29 minutes')",
			timeoutSeconds: 1800
		});
		expirePendingCommands();
		expect(statusOf('exp-long-timeout')).toBe('pending');
	});
});
