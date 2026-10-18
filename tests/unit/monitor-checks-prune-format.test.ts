/**
 * Regression: the app writes ISO-8601 `checked_at` timestamps
 * (`new Date().toISOString()`), but the prune compared them against a
 * SQLite `datetime('now', '-48 hours')` string. ISO 'T' sorts after ' ',
 * so every ISO-8601 row compared as newer than the cutoff and monitor
 * checks were never pruned.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-monitor-prune');

let db: typeof import('../../src/lib/server/db.js').db;
let pruneOldMonitorChecks: typeof import('../../src/services/monitors.js').pruneOldMonitorChecks;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATA_DIR = TEST_DIR;
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'monitor-prune.db');
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	db = (await import('../../src/lib/server/db.js')).db;
	pruneOldMonitorChecks = (await import('../../src/services/monitors.js')).pruneOldMonitorChecks;
});

describe('pruneOldMonitorChecks — timestamp formats', () => {
	it('prunes ISO-8601 rows past the 48h cutoff and keeps recent ones', () => {
		db.prepare("INSERT INTO monitors (id, data, enabled, status) VALUES ('m-1', '{}', 1, 'up')").run();

		const insert = db.prepare(
			`INSERT INTO monitor_checks (id, monitor_id, check_type, status, checked_at) VALUES (?, 'm-1', 'http', 'up', ?)`
		);
		// Just past the cutoff with the same date part as the cutoff string:
		// a raw text comparison against SQLite's 'YYYY-MM-DD HH:MM:SS' misses
		// this row ('T' sorts after ' '), so it survived pruning.
		const cutoffMs = Date.now() - 48 * 3_600_000;
		insert.run('c-expired-iso', new Date(cutoffMs - 60_000).toISOString());
		insert.run('c-recent-iso', new Date(Date.now() - 3_600_000).toISOString());
		// Legacy rows written before the ISO switch must keep being pruned too.
		db.prepare(
			`INSERT INTO monitor_checks (id, monitor_id, check_type, status, checked_at) VALUES ('c-expired-sqlite', 'm-1', 'http', 'up', datetime('now', '-72 hours'))`
		).run();

		pruneOldMonitorChecks();

		const remaining = db.prepare('SELECT id FROM monitor_checks ORDER BY id').all() as { id: string }[];
		expect(remaining.map(r => r.id)).toEqual(['c-recent-iso']);
	});
});
