import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-boot-perf');

let processBootPerformanceResult: typeof import('../../src/services/boot-performance.js').processBootPerformanceResult;
let getBootPerformanceTrend: typeof import('../../src/services/boot-performance.js').getBootPerformanceTrend;
let getLatestBootPerformance: typeof import('../../src/services/boot-performance.js').getLatestBootPerformance;
let listFindingsByAgent: typeof import('../../src/services/agent-findings.js').listFindingsByAgent;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'boot.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const bp = await import('../../src/services/boot-performance.js');
	const findings = await import('../../src/services/agent-findings.js');
	const dbMod = await import('../../src/lib/server/db.js');
	processBootPerformanceResult = bp.processBootPerformanceResult;
	getBootPerformanceTrend = bp.getBootPerformanceTrend;
	getLatestBootPerformance = bp.getLatestBootPerformance;
	listFindingsByAgent = findings.listFindingsByAgent;
	db = dbMod.db;

	db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('a-bp', 'host-bp', 'host-bp', 'linux', 'amd64', 'tk-bp')`).run();
});

beforeEach(() => {
	db.prepare("DELETE FROM agent_findings WHERE agent_id = 'a-bp'").run();
	db.prepare("DELETE FROM agent_collector_results WHERE agent_id = 'a-bp'").run();
});

describe('boot performance', () => {
	it('rejects payloads without a valid bootTimestamp', () => {
		processBootPerformanceResult('cmd-1', 'a-bp', { bootTimestamp: 'not-a-date', totalBootSeconds: 30 });
		expect(getLatestBootPerformance('a-bp')).toBeNull();
	});

	it('records a valid payload and exposes it in the trend', () => {
		processBootPerformanceResult('cmd-1', 'a-bp', {
			bootTimestamp: '2026-05-01T08:00:00Z',
			biosSeconds: 4.2,
			osLoaderSeconds: 3.1,
			desktopReadySeconds: 22.5,
			totalBootSeconds: 29.8,
			startupItemCount: 47,
			source: 'systemd-analyze'
		});
		const latest = getLatestBootPerformance('a-bp');
		expect(latest).not.toBeNull();
		expect(latest!.totalBootSeconds).toBe(29.8);
		expect(latest!.biosSeconds).toBe(4.2);
		expect(latest!.startupItemCount).toBe(47);

		const trend = getBootPerformanceTrend('a-bp');
		expect(trend.history).toHaveLength(1);
		expect(trend.medianTotalSeconds).toBe(29.8);
		expect(trend.slowBootCount).toBe(0);
	});

	it('dedups by bootTimestamp — re-running on the same boot session is a no-op', () => {
		processBootPerformanceResult('cmd-1', 'a-bp', {
			bootTimestamp: '2026-05-01T08:00:00Z',
			totalBootSeconds: 30,
			biosSeconds: 0, osLoaderSeconds: 0, desktopReadySeconds: 30, startupItemCount: 10, source: 's'
		});
		processBootPerformanceResult('cmd-2', 'a-bp', {
			bootTimestamp: '2026-05-01T08:00:00Z',
			totalBootSeconds: 30,
			biosSeconds: 0, osLoaderSeconds: 0, desktopReadySeconds: 30, startupItemCount: 10, source: 's'
		});
		expect(getBootPerformanceTrend('a-bp').history).toHaveLength(1);
	});

	it('emits a low-severity policy finding when total > 90s', () => {
		processBootPerformanceResult('cmd-slow', 'a-bp', {
			bootTimestamp: '2026-05-01T09:00:00Z',
			totalBootSeconds: 120,
			biosSeconds: 5, osLoaderSeconds: 10, desktopReadySeconds: 105, startupItemCount: 50, source: 's'
		});
		const f = listFindingsByAgent('a-bp', 50).filter(x => x.category === 'policy' && x.title.startsWith('Slow boot'));
		expect(f).toHaveLength(1);
		expect(f[0].severity).toBe('low');
		expect(f[0].evidence.totalBootSeconds).toBe(120);
	});

	it('escalates to medium severity when total > 180s', () => {
		processBootPerformanceResult('cmd-very-slow', 'a-bp', {
			bootTimestamp: '2026-05-01T10:00:00Z',
			totalBootSeconds: 250,
			biosSeconds: 5, osLoaderSeconds: 10, desktopReadySeconds: 235, startupItemCount: 50, source: 's'
		});
		const f = listFindingsByAgent('a-bp', 50).filter(x => x.category === 'policy' && x.title.startsWith('Slow boot'));
		expect(f).toHaveLength(1);
		expect(f[0].severity).toBe('medium');
	});

	it('does NOT emit a finding when total <= 90s', () => {
		processBootPerformanceResult('cmd-fast', 'a-bp', {
			bootTimestamp: '2026-05-01T11:00:00Z',
			totalBootSeconds: 30,
			biosSeconds: 4, osLoaderSeconds: 3, desktopReadySeconds: 23, startupItemCount: 30, source: 's'
		});
		const f = listFindingsByAgent('a-bp', 50).filter(x => x.title.startsWith('Slow boot'));
		expect(f).toHaveLength(0);
	});

	it('history percentiles handle multiple boots correctly', () => {
		const ts = (i: number) => `2026-04-${String(i).padStart(2, '0')}T08:00:00Z`;
		const totals = [25, 27, 32, 28, 95, 30, 26, 100, 28, 31];
		for (let i = 0; i < totals.length; i++) {
			processBootPerformanceResult(`cmd-${i}`, 'a-bp', {
				bootTimestamp: ts(i + 1),
				totalBootSeconds: totals[i],
				biosSeconds: 0, osLoaderSeconds: 0, desktopReadySeconds: totals[i], startupItemCount: 10, source: 's'
			});
		}
		const trend = getBootPerformanceTrend('a-bp');
		expect(trend.history).toHaveLength(10);
		expect(trend.slowBootCount).toBe(2);
		expect(trend.p95TotalSeconds).toBe(100);
		// median of [25,26,27,28,28,30,31,32,95,100] = (28+30)/2 = 29
		expect(trend.medianTotalSeconds).toBe(29);
	});
});
