import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AutoUpdateAgent } from '../../src/services/agent-auto-update.js';

// by totp.test.ts / security-hardening.test.ts.
const TEST_DIR = path.resolve('data-test-auto-update');

let computeAutoUpdateDispatch: typeof import('../../src/services/agent-auto-update.js').computeAutoUpdateDispatch;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'auto-update.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const m = await import('../../src/services/agent-auto-update.js');
	computeAutoUpdateDispatch = m.computeAutoUpdateDispatch;
});

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-04-24T12:00:00Z').getTime();

function agent(overrides: Partial<AutoUpdateAgent>): AutoUpdateAgent {
	return {
		id: 'a1',
		status: 'online',
		enabled: true,
		autoUpdateSoftware: false,
		autoUpdateOS: false,
		autoUpdateIntervalHours: 24,
		lastAutoUpdateAt: null,
		...overrides
	};
}

describe('computeAutoUpdateDispatch', () => {
	it('skips agents with no auto-update flags set', () => {
		const out = computeAutoUpdateDispatch([agent({})], NOW);
		expect(out).toEqual([]);
	});

	it('skips disabled agents even when flags are on', () => {
		const out = computeAutoUpdateDispatch([
			agent({ enabled: false, autoUpdateSoftware: true })
		], NOW);
		expect(out).toEqual([]);
	});

	it('skips offline agents', () => {
		const out = computeAutoUpdateDispatch([
			agent({ status: 'offline', autoUpdateSoftware: true })
		], NOW);
		expect(out).toEqual([]);
	});

	it('dispatches to stale agents (they may be coming back)', () => {
		const out = computeAutoUpdateDispatch([
			agent({ status: 'stale', autoUpdateSoftware: true })
		], NOW);
		expect(out).toEqual([{ agentId: 'a1', type: 'software_update' }]);
	});

	it('dispatches software_update when never run before', () => {
		const out = computeAutoUpdateDispatch([
			agent({ autoUpdateSoftware: true, lastAutoUpdateAt: null })
		], NOW);
		expect(out).toEqual([{ agentId: 'a1', type: 'software_update' }]);
	});

	it('dispatches os_update when never run before', () => {
		const out = computeAutoUpdateDispatch([
			agent({ autoUpdateOS: true })
		], NOW);
		expect(out).toEqual([{ agentId: 'a1', type: 'os_update' }]);
	});

	it('dispatches BOTH types when both flags are set', () => {
		const out = computeAutoUpdateDispatch([
			agent({ autoUpdateSoftware: true, autoUpdateOS: true })
		], NOW);
		expect(out.map(x => x.type).sort()).toEqual(['os_update', 'software_update']);
	});

	it('respects interval — does NOT dispatch when last run was recent', () => {
		const recent = new Date(NOW - 1 * HOUR).toISOString();
		const out = computeAutoUpdateDispatch([
			agent({ autoUpdateSoftware: true, lastAutoUpdateAt: recent })
		], NOW);
		expect(out).toEqual([]);
	});

	it('respects interval — dispatches when last run was > intervalHours ago', () => {
		const old = new Date(NOW - 25 * HOUR).toISOString();
		const out = computeAutoUpdateDispatch([
			agent({ autoUpdateSoftware: true, lastAutoUpdateAt: old })
		], NOW);
		expect(out).toEqual([{ agentId: 'a1', type: 'software_update' }]);
	});

	it('respects per-agent intervalHours override', () => {
		const run5hAgo = new Date(NOW - 5 * HOUR).toISOString();
		const out = computeAutoUpdateDispatch([
			agent({
				autoUpdateSoftware: true,
				autoUpdateIntervalHours: 4,
				lastAutoUpdateAt: run5hAgo
			})
		], NOW);
		expect(out).toEqual([{ agentId: 'a1', type: 'software_update' }]);
	});

	it('treats missing Z timezone suffix as UTC (SQLite datetime() format)', () => {
		const noZ = '2026-04-23 11:00:00'; // 25 h before NOW (12:00 on 2026-04-24)
		const out = computeAutoUpdateDispatch([
			agent({ autoUpdateSoftware: true, lastAutoUpdateAt: noZ })
		], NOW);
		expect(out).toEqual([{ agentId: 'a1', type: 'software_update' }]);
	});

	it('falls back to 24h when intervalHours is 0 or negative', () => {
		const justUnder24h = new Date(NOW - 23 * HOUR).toISOString();
		const out = computeAutoUpdateDispatch([
			agent({
				autoUpdateSoftware: true,
				autoUpdateIntervalHours: 0,
				lastAutoUpdateAt: justUnder24h
			})
		], NOW);
		expect(out).toEqual([]); // not yet 24h
	});

	it('handles a mixed fleet correctly', () => {
		const old = new Date(NOW - 48 * HOUR).toISOString();
		const recent = new Date(NOW - 1 * HOUR).toISOString();
		const out = computeAutoUpdateDispatch([
			agent({ id: 'due-sw', autoUpdateSoftware: true, lastAutoUpdateAt: old }),
			agent({ id: 'due-os', autoUpdateOS: true, lastAutoUpdateAt: null }),
			agent({ id: 'too-recent', autoUpdateSoftware: true, lastAutoUpdateAt: recent }),
			agent({ id: 'disabled', enabled: false, autoUpdateSoftware: true }),
			agent({ id: 'offline', status: 'offline', autoUpdateSoftware: true }),
			agent({ id: 'no-flags' })
		], NOW);
		expect(out).toEqual([
			{ agentId: 'due-sw', type: 'software_update' },
			{ agentId: 'due-os', type: 'os_update' }
		]);
	});

	it('REGRESSION: recent check-in does not block auto-update dispatch', () => {
		const dayAgo = new Date(NOW - 25 * HOUR).toISOString();
		const out = computeAutoUpdateDispatch([
			agent({ autoUpdateSoftware: true, lastAutoUpdateAt: dayAgo })
		], NOW);
		expect(out.length).toBe(1);
	});
});
