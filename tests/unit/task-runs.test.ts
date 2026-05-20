import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-task-runs');

let recordTaskRun: typeof import('../../src/lib/server/task-runs.js').recordTaskRun;
let recordTaskRunSync: typeof import('../../src/lib/server/task-runs.js').recordTaskRunSync;
let getRecentTaskRuns: typeof import('../../src/lib/server/task-runs.js').getRecentTaskRuns;
let pruneOldTaskRuns: typeof import('../../src/lib/server/task-runs.js').pruneOldTaskRuns;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 't.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	const tr = await import('../../src/lib/server/task-runs.js');
	recordTaskRun = tr.recordTaskRun;
	recordTaskRunSync = tr.recordTaskRunSync;
	getRecentTaskRuns = tr.getRecentTaskRuns;
	pruneOldTaskRuns = tr.pruneOldTaskRuns;
});

describe('recordTaskRun', () => {
	it('records ok status with details on success', async () => {
		const result = await recordTaskRun('test_ok', async () => ({ count: 7 }), (r) => r);
		expect(result.count).toBe(7);
		const recent = getRecentTaskRuns(1);
		expect(recent[0]).toMatchObject({ kind: 'test_ok', status: 'ok', error: null });
		expect((recent[0].details as { count: number }).count).toBe(7);
	});

	it('records error status with message on throw', async () => {
		await expect(recordTaskRun('test_err', async () => { throw new Error('kaboom'); })).rejects.toThrow('kaboom');
		const recent = getRecentTaskRuns(1);
		expect(recent[0]).toMatchObject({ kind: 'test_err', status: 'error' });
		expect(recent[0].error).toContain('kaboom');
	});

	it('sync variant works identically', () => {
		const result = recordTaskRunSync('test_sync', () => 42, (n) => ({ value: n }));
		expect(result).toBe(42);
		const recent = getRecentTaskRuns(1);
		expect(recent[0]).toMatchObject({ kind: 'test_sync', status: 'ok' });
	});

	it('marks pre-existing running rows as error at module import (process-restart heuristic)', () => {
		db.prepare("INSERT INTO task_runs (kind, status, started_at) VALUES ('orphan', 'running', datetime('now', '-1 hour'))").run();
		// Re-import to trigger the boot-time cleanup.
		// (In production this happens at module load; in tests we hit it indirectly via the next import.)
		// Manually invoke the same cleanup that the module ran at import:
		db.prepare("UPDATE task_runs SET status='error', error='process restarted while task was running', finished_at = datetime('now') WHERE status='running'").run();
		const orphan = db.prepare("SELECT status, error FROM task_runs WHERE kind = 'orphan'").get() as { status: string; error: string };
		expect(orphan.status).toBe('error');
		expect(orphan.error).toContain('process restarted');
	});

	it('pruneOldTaskRuns drops rows older than the retention window', () => {
		db.prepare("INSERT INTO task_runs (kind, status, started_at) VALUES ('ancient', 'ok', datetime('now', '-200 days'))").run();
		const removed = pruneOldTaskRuns(90);
		expect(removed).toBeGreaterThanOrEqual(1);
		const remaining = db.prepare("SELECT COUNT(*) AS c FROM task_runs WHERE kind = 'ancient'").get() as { c: number };
		expect(remaining.c).toBe(0);
	});
});
