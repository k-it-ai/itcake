/**
 * Regression test: `pruneOldAgentMetrics` and `pruneOldAgentEvents`
 * clamp `rmm.metricsRetentionHours` before interpolating it into a
 * `datetime('now', '-N hours')` modifier. Without the clamp:
 *   - `0` → `-0 hours` → SQLite evaluates to NOW → pruning deletes
 *     the most recent metrics, causing data loss on every tick.
 *   - negative value → `--N hours` → SQLite parses the modifier as
 *     NULL → `ts < NULL` is never true → no metrics are pruned and
 *     the table grows unbounded, eventually filling the disk.
 * CLAUDE.md notes there is no `rmmSettingsSchema` for the rmm section,
 * so the operator edits the row directly via SQL and the call-site
 * clamp is the only gate.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-rmm-retention-clamp');

let db: typeof import('../../src/lib/server/db.js').db;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;
let pruneOldAgentMetrics: typeof import('../../src/services/agent-metrics.js').pruneOldAgentMetrics;
let pruneOldAgentEvents: typeof import('../../src/services/agent-events.js').pruneOldAgentEvents;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'clamp.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	setSetting = dbMod.setSetting;
	pruneOldAgentMetrics = (await import('../../src/services/agent-metrics.js')).pruneOldAgentMetrics;
	pruneOldAgentEvents = (await import('../../src/services/agent-events.js')).pruneOldAgentEvents;
});

beforeEach(() => {
	db.prepare('DELETE FROM agent_metrics').run();
	db.prepare('DELETE FROM agent_events').run();
	db.prepare(
		"INSERT OR REPLACE INTO agents (id, name, hostname, os, arch, tags, token_hash, hmac_secret) VALUES ('a-1', 'test', 'h', 'linux', 'amd64', '[]', 'th', '')"
	).run();
});

let nextId = 1;
function seedMetric(agedHours: number) {
	// ISO-8601 like the app writes it — the format the prune must parse.
	db.prepare(
		`INSERT INTO agent_metrics (id, agent_id, cpu_percent, recorded_at) VALUES (?, 'a-1', 1, ?)`
	).run(`m-${nextId++}`, new Date(Date.now() - agedHours * 3_600_000).toISOString());
}

function seedEvent(agedHours: number) {
	db.prepare(
		`INSERT INTO agent_events (id, agent_id, level, message, occurred_at, received_at)
		 VALUES (?, 'a-1', 'warning', 'msg', datetime('now', ?), datetime('now', ?))`
	).run(`e-${nextId++}`, `-${agedHours} hours`, `-${agedHours} hours`);
}

describe('pruneOldAgentMetrics — retention clamp', () => {
	it('clamps `metricsRetentionHours = 0` so fresh metrics are NOT deleted', () => {
		seedMetric(1);    // 1 h old — should be kept
		seedMetric(100);  // 100 h old — should be pruned at default 48 h
		setSetting('rmm', {
			defaultCheckinInterval: 30, staleThresholdMinutes: 2,
			metricsRetentionHours: 0, commandTimeoutSeconds: 300
		});
		pruneOldAgentMetrics();
		const remaining = db.prepare('SELECT COUNT(*) AS n FROM agent_metrics').get() as { n: number };
		// 0 clamps to 48 h default → keeps 1 h row, prunes 100 h row.
		expect(remaining.n).toBe(1);
	});

	it('clamps a negative `metricsRetentionHours` so the prune still runs', () => {
		seedMetric(1);    // 1 h old
		seedMetric(100);  // 100 h old
		setSetting('rmm', {
			defaultCheckinInterval: 30, staleThresholdMinutes: 2,
			metricsRetentionHours: -1, commandTimeoutSeconds: 300
		});
		pruneOldAgentMetrics();
		const remaining = db.prepare('SELECT COUNT(*) AS n FROM agent_metrics').get() as { n: number };
		// Pre-fix: `-N hours` with N=-1 produced `--1 hours` → NULL
		// modifier → ts < NULL → 0 rows pruned → both rows remain.
		// Post-fix: clamps to 48 h → 100 h row pruned, 1 h row kept.
		expect(remaining.n).toBe(1);
	});

	it('clamps a non-finite (NaN-coerced) value', () => {
		seedMetric(1);
		seedMetric(100);
		setSetting('rmm', {
			defaultCheckinInterval: 30, staleThresholdMinutes: 2,
			metricsRetentionHours: NaN as unknown as number,
			commandTimeoutSeconds: 300
		});
		pruneOldAgentMetrics();
		const remaining = db.prepare('SELECT COUNT(*) AS n FROM agent_metrics').get() as { n: number };
		expect(remaining.n).toBe(1);
	});

	it('respects a sane positive value (24 h prunes anything older than 24 h)', () => {
		seedMetric(1);     // keep
		seedMetric(12);    // keep
		seedMetric(48);    // prune
		setSetting('rmm', {
			defaultCheckinInterval: 30, staleThresholdMinutes: 2,
			metricsRetentionHours: 24, commandTimeoutSeconds: 300
		});
		pruneOldAgentMetrics();
		const remaining = db.prepare('SELECT COUNT(*) AS n FROM agent_metrics').get() as { n: number };
		expect(remaining.n).toBe(2);
	});

	it('caps absurdly large values (1 year max — 8760 h)', () => {
		seedMetric(8761);
		setSetting('rmm', {
			defaultCheckinInterval: 30, staleThresholdMinutes: 2,
			metricsRetentionHours: 1_000_000, commandTimeoutSeconds: 300
		});
		pruneOldAgentMetrics();
		const remaining = db.prepare('SELECT COUNT(*) AS n FROM agent_metrics').get() as { n: number };
		// Capped at 8760 h → the 8761 h row is pruned.
		expect(remaining.n).toBe(0);
	});
});

describe('pruneOldAgentEvents — retention clamp', () => {
	it('mirrors the metrics clamp for the events table', () => {
		seedEvent(1);
		seedEvent(100);
		setSetting('rmm', {
			defaultCheckinInterval: 30, staleThresholdMinutes: 2,
			metricsRetentionHours: -5, commandTimeoutSeconds: 300
		});
		pruneOldAgentEvents();
		const remaining = db.prepare('SELECT COUNT(*) AS n FROM agent_events').get() as { n: number };
		expect(remaining.n).toBe(1);
	});
});
