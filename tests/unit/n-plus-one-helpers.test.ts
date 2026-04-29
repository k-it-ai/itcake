import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Disposable-DB test for the multi-row "fetch latest per group" helpers
// that replaced per-agent / per-monitor SELECT loops in the listing-page
// loaders.
const TEST_DIR = path.resolve('data-test-n1');

let db: typeof import('../../src/lib/server/db.js').db;
let getLatestMetricsForAgents: typeof import('../../src/services/agent-metrics.js').getLatestMetricsForAgents;
let getDailyHistoryForMonitors: typeof import('../../src/services/monitors.js').getDailyHistoryForMonitors;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'n1.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const am = await import('../../src/services/agent-metrics.js');
	const mon = await import('../../src/services/monitors.js');
	db = dbMod.db;
	getLatestMetricsForAgents = am.getLatestMetricsForAgents;
	getDailyHistoryForMonitors = mon.getDailyHistoryForMonitors;

	db.prepare('DELETE FROM agent_metrics').run();
	db.prepare('DELETE FROM agents').run();
	db.prepare('DELETE FROM monitor_daily').run();
	db.prepare('DELETE FROM monitor_checks').run();
	db.prepare('DELETE FROM monitors').run();

	// Satisfy the agent_metrics → agents FK constraint
	const insertAgent = db.prepare(
		"INSERT INTO agents (id, name, hostname, os, arch, token_hash) VALUES (?, ?, '', '', '', ?)"
	);
	insertAgent.run('a', 'agent-a', 'h1');
	insertAgent.run('b', 'agent-b', 'h2');
});

const insertMetric = (agentId: string, recordedAt: string, cpu: number) =>
	db.prepare(
		'INSERT INTO agent_metrics (id, agent_id, cpu_percent, memory_used_bytes, memory_total_bytes, disk_used_bytes, disk_total_bytes, load_avg_1, load_avg_5, load_avg_15, uptime_seconds, recorded_at) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)'
	).run(`m-${agentId}-${recordedAt}`, agentId, cpu, recordedAt);

describe('getLatestMetricsForAgents', () => {
	it('returns empty Map for empty input', () => {
		expect(getLatestMetricsForAgents([]).size).toBe(0);
	});

	it('returns the most recent row per agent', () => {
		insertMetric('a', '2026-01-01T10:00:00Z', 10);
		insertMetric('a', '2026-01-01T11:00:00Z', 20);
		insertMetric('a', '2026-01-01T12:00:00Z', 30);
		insertMetric('b', '2026-01-01T11:30:00Z', 50);

		const out = getLatestMetricsForAgents(['a', 'b']);
		expect(out.size).toBe(2);
		expect(out.get('a')?.cpuPercent).toBe(30);
		expect(out.get('b')?.cpuPercent).toBe(50);
	});

	it('omits agents with no metrics from the Map', () => {
		const out = getLatestMetricsForAgents(['a', 'no-such-agent']);
		expect(out.has('a')).toBe(true);
		expect(out.has('no-such-agent')).toBe(false);
	});

	it('does not leak metrics from agents not in the requested set', () => {
		const out = getLatestMetricsForAgents(['a']);
		expect(out.has('a')).toBe(true);
		expect(out.has('b')).toBe(false);
	});
});

const insertDaily = (monitorId: string, date: string, uptime: number) =>
	db.prepare(
		"INSERT INTO monitor_daily (monitor_id, check_type, date, uptime_percent, total_checks, failed_checks) VALUES (?, 'http', ?, ?, 100, 0)"
	).run(monitorId, date, uptime);

describe('getDailyHistoryForMonitors', () => {
	beforeAll(() => {
		// Two monitors, three days of history each, plus one row before the
		// `since` boundary that the helper must filter out.
		db.prepare("INSERT INTO monitors (id, data, enabled, status) VALUES ('m1', '{}', 1, 'up')").run();
		db.prepare("INSERT INTO monitors (id, data, enabled, status) VALUES ('m2', '{}', 1, 'up')").run();
		insertDaily('m1', '2026-01-01', 99);
		insertDaily('m1', '2026-01-02', 100);
		insertDaily('m1', '2026-01-03', 95);
		insertDaily('m2', '2026-01-02', 80);
		insertDaily('m2', '2026-01-03', 90);
		insertDaily('m1', '2025-12-31', 100); // before window
	});

	it('returns empty array for empty input', () => {
		expect(getDailyHistoryForMonitors([], '2026-01-01')).toEqual([]);
	});

	it('returns rows for each monitor in the IN-list, filtered by since', () => {
		const rows = getDailyHistoryForMonitors(['m1', 'm2'], '2026-01-01');
		// 3 days × m1 + 2 days × m2 = 5
		expect(rows.length).toBe(5);
		// Window enforced — none from 2025-12-31
		expect(rows.find(r => r.date === '2025-12-31')).toBeUndefined();
	});

	it('does not leak rows from monitors not in the requested set', () => {
		const rows = getDailyHistoryForMonitors(['m1'], '2026-01-01');
		expect(rows.every(r => r.monitorId === 'm1')).toBe(true);
	});
});
