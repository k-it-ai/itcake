import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-agent-reliability');

let computeScore: typeof import('../../src/services/agent-reliability.js').computeScore;
let computeTrend: typeof import('../../src/services/agent-reliability.js').computeTrend;
let computeMtbf: typeof import('../../src/services/agent-reliability.js').computeMtbf;
let processReliabilityResult: typeof import('../../src/services/agent-reliability.js').processReliabilityResult;
let computeAggregateScore: typeof import('../../src/services/agent-reliability.js').computeAggregateScore;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'reliability.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const mod = await import('../../src/services/agent-reliability.js');
	const dbMod = await import('../../src/lib/server/db.js');
	computeScore = mod.computeScore;
	computeTrend = mod.computeTrend;
	computeMtbf = mod.computeMtbf;
	processReliabilityResult = mod.processReliabilityResult;
	computeAggregateScore = mod.computeAggregateScore;
	db = dbMod.db;

	db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('rel-1', 'rel-1', 'rel-1', 'linux', 'amd64', 'tk-rel-1')`).run();
});

describe('computeScore', () => {
	it('perfect uptime no failures returns 100', () => {
		expect(computeScore({ uptimeSeconds: 86400, crashes: 0, hangs: 0, serviceFailures: 0, hardwareErrors: 0 })).toBe(100);
	});

	it('zero uptime with all failures returns 0', () => {
		expect(computeScore({ uptimeSeconds: 0, crashes: 10, hangs: 10, serviceFailures: 10, hardwareErrors: 10 })).toBe(0);
	});

	it('uptime 50% one crash returns weighted result around 67', () => {
		const score = computeScore({ uptimeSeconds: 43200, crashes: 1, hangs: 0, serviceFailures: 0, hardwareErrors: 0 });
		expect(score).toBeGreaterThan(60);
		expect(score).toBeLessThan(85);
	});

	it('one hardware error knocks 25% off the hardware factor', () => {
		const score = computeScore({ uptimeSeconds: 86400, crashes: 0, hangs: 0, serviceFailures: 0, hardwareErrors: 1 });
		expect(score).toBeLessThan(100);
		expect(score).toBeGreaterThanOrEqual(95);
	});

	it('non-finite uptime treated as 0', () => {
		const score = computeScore({ uptimeSeconds: Number.NaN, crashes: 0, hangs: 0, serviceFailures: 0, hardwareErrors: 0 });
		expect(score).toBe(70);
	});

	it('weights sum to 100 — each factor at 0 produces 0', () => {
		expect(computeScore({ uptimeSeconds: 0, crashes: 100, hangs: 100, serviceFailures: 100, hardwareErrors: 100 })).toBe(0);
	});
});

describe('computeTrend', () => {
	it('rising line returns up', () => {
		const scores = Array.from({ length: 30 }, (_, i) => 50 + i);
		const t = computeTrend(scores);
		expect(t.trend).toBe('up');
		expect(t.confidence).toBeGreaterThan(0.95);
	});

	it('falling line returns down', () => {
		const scores = Array.from({ length: 30 }, (_, i) => 95 - i);
		const t = computeTrend(scores);
		expect(t.trend).toBe('down');
		expect(t.confidence).toBeGreaterThan(0.95);
	});

	it('flat line returns flat with high coverage', () => {
		const scores = Array.from({ length: 30 }, () => 80);
		const t = computeTrend(scores);
		expect(t.trend).toBe('flat');
	});

	it('few data points returns low confidence', () => {
		const t = computeTrend([90, 88, 91]);
		expect(t.confidence).toBeLessThan(0.2);
	});

	it('single data point returns flat zero confidence', () => {
		const t = computeTrend([85]);
		expect(t.trend).toBe('flat');
		expect(t.confidence).toBe(0);
	});

	it('coverage capped at 1.0 even with > 30 points', () => {
		const scores = Array.from({ length: 60 }, (_, i) => 50 + (i % 30));
		const t = computeTrend(scores);
		expect(t.confidence).toBeLessThanOrEqual(1.0);
	});
});

describe('computeMtbf', () => {
	it('no failures returns null', () => {
		expect(computeMtbf({ crashes: 0, hangs: 0, serviceFailures: 0, hardwareErrors: 0, uptimeHours: 720 })).toBe(null);
	});

	it('zero uptime returns 0', () => {
		expect(computeMtbf({ crashes: 1, hangs: 0, serviceFailures: 0, hardwareErrors: 0, uptimeHours: 0 })).toBe(0);
	});

	it('one failure in 720h is 720', () => {
		expect(computeMtbf({ crashes: 1, hangs: 0, serviceFailures: 0, hardwareErrors: 0, uptimeHours: 720 })).toBe(720);
	});

	it('multiple failures averaged', () => {
		expect(computeMtbf({ crashes: 2, hangs: 1, serviceFailures: 1, hardwareErrors: 0, uptimeHours: 1000 })).toBe(250);
	});
});

describe('processReliabilityResult + computeAggregateScore', () => {
	it('records and aggregates daily payloads', () => {
		const today = new Date('2026-05-06T00:00:00Z');
		for (let i = 5; i >= 0; i--) {
			const d = new Date(today);
			d.setUTCDate(today.getUTCDate() - i);
			const dayStr = d.toISOString().slice(0, 10);
			processReliabilityResult(`cmd-${i}`, 'rel-1', {
				day: dayStr,
				uptimeSeconds: 86400,
				crashes: 0,
				hangs: 0,
				serviceFailures: 0,
				hardwareErrors: 0
			});
		}
		const agg = computeAggregateScore('rel-1');
		expect(agg.score).toBe(100);
		expect(agg.dailyBuckets.length).toBe(6);
		expect(agg.mtbfHours).toBe(null);
	});

	it('rejects invalid payload (missing day)', () => {
		const before = computeAggregateScore('rel-1').dailyBuckets.length;
		processReliabilityResult('bad-1', 'rel-1', { uptimeSeconds: 100 } as Record<string, unknown>);
		processReliabilityResult('bad-2', 'rel-1', { day: 'not-a-date' } as Record<string, unknown>);
		const after = computeAggregateScore('rel-1').dailyBuckets.length;
		expect(after).toBe(before);
	});

	it('agent with no data returns score 0 trend flat', () => {
		db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('rel-empty', 'rel-empty', 'rel-empty', 'linux', 'amd64', 'tk-rel-empty')`).run();
		const agg = computeAggregateScore('rel-empty');
		expect(agg.score).toBe(0);
		expect(agg.trend).toBe('flat');
		expect(agg.dailyBuckets.length).toBe(0);
	});
});
