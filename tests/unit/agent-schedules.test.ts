import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

const TEST_DIR = path.resolve('data-test-schedule');

let db: Database;
let processDueSchedules: typeof import('../../src/services/agent-schedules.js').processDueSchedules;
let listEvents: typeof import('../../src/services/agent-events.js').listEvents;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'sched.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbModule = await import('../../src/lib/server/db.js');
	db = dbModule.db;
	processDueSchedules = (await import('../../src/services/agent-schedules.js')).processDueSchedules;
	listEvents = (await import('../../src/services/agent-events.js')).listEvents;
});

describe('processDueSchedules', () => {
	it('records an agent_event when dispatch fails (M2 regression: legacy agent surfaces in UI)', () => {
		// "Legacy" agent: empty hmac_secret triggers LegacyEnrollmentError on dispatch.
		const agentId = 'agent-legacy-sched';
		db.prepare(
			`INSERT INTO agents (id, name, hostname, os, arch, token_hash, hmac_secret, status, enabled)
			 VALUES (?, ?, ?, ?, ?, ?, '', 'online', 1)`
		).run(agentId, 'legacy', 'legacy-host', 'linux', 'amd64', 'token-hash-' + agentId);

		// Due schedule (next_run_at in the past) pointing at the legacy agent.
		db.prepare(
			`INSERT INTO agent_schedules (id, agent_id, name, type, payload, cron_expression, timeout_seconds, enabled, next_run_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now', '-1 minute'), 'system')`
		).run('sched-legacy-1', agentId, 'nightly-cleanup', 'shell', JSON.stringify({ command: 'echo' }), '0 0 * * *', 60);

		const dispatched = processDueSchedules();
		expect(dispatched).toBe(0);

		const events = listEvents(agentId, 100);
		expect(events.length).toBeGreaterThan(0);
		const ev = events[0];
		expect(ev.source).toBe('schedule_dispatch_failed');
		expect(ev.level).toBe('error');
		expect(ev.message).toContain('nightly-cleanup');
		expect(ev.message.toLowerCase()).toContain('re-enroll');
	});

	it('rolls next_run_at forward even when dispatch failed (so the slot is not stuck)', () => {
		const agentId = 'agent-legacy-sched-2';
		db.prepare(
			`INSERT INTO agents (id, name, hostname, os, arch, token_hash, hmac_secret, status, enabled)
			 VALUES (?, ?, ?, ?, ?, ?, '', 'online', 1)`
		).run(agentId, 'legacy2', 'legacy2-host', 'linux', 'amd64', 'token-hash-' + agentId);

		db.prepare(
			`INSERT INTO agent_schedules (id, agent_id, name, type, payload, cron_expression, timeout_seconds, enabled, next_run_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now', '-1 minute'), 'system')`
		).run('sched-legacy-2', agentId, 's2', 'shell', JSON.stringify({ command: 'echo' }), '0 0 * * *', 60);

		processDueSchedules();
		const row = db.prepare('SELECT next_run_at FROM agent_schedules WHERE id = ?').get('sched-legacy-2') as { next_run_at: string };
		expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
	});
});
