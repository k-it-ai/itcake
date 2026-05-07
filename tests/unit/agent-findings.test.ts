import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-agent-findings');

let recordFinding: typeof import('../../src/services/agent-findings.js').recordFinding;
let listFindingsByAgent: typeof import('../../src/services/agent-findings.js').listFindingsByAgent;
let updateFindingState: typeof import('../../src/services/agent-findings.js').updateFindingState;
let getOpenFindingCounts: typeof import('../../src/services/agent-findings.js').getOpenFindingCounts;
let fingerprintOf: typeof import('../../src/services/agent-findings.js').fingerprintOf;
let recordCollectorResult: typeof import('../../src/services/agent-collector-results.js').recordCollectorResult;
let getLatestCollectorResult: typeof import('../../src/services/agent-collector-results.js').getLatestCollectorResult;
let pruneOldCollectorResults: typeof import('../../src/services/agent-collector-results.js').pruneOldCollectorResults;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'findings.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const mod = await import('../../src/services/agent-findings.js');
	const cmod = await import('../../src/services/agent-collector-results.js');
	const dbMod = await import('../../src/lib/server/db.js');
	recordFinding = mod.recordFinding;
	listFindingsByAgent = mod.listFindingsByAgent;
	updateFindingState = mod.updateFindingState;
	getOpenFindingCounts = mod.getOpenFindingCounts;
	fingerprintOf = mod.fingerprintOf;
	recordCollectorResult = cmod.recordCollectorResult;
	getLatestCollectorResult = cmod.getLatestCollectorResult;
	pruneOldCollectorResults = cmod.pruneOldCollectorResults;
	db = dbMod.db;

	db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('a-1', 'host-1', 'host-1', 'linux', 'amd64', 'tk-1')`).run();
	db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('a-2', 'host-2', 'host-2', 'linux', 'amd64', 'tk-2')`).run();
});

describe('fingerprintOf', () => {
	it('stable hash 32 chars', () => {
		const a = fingerprintOf('peripheral', ['vendor-1', 'product-1', 'serial-x']);
		const b = fingerprintOf('peripheral', ['vendor-1', 'product-1', 'serial-x']);
		expect(a).toBe(b);
		expect(a.length).toBe(32);
	});

	it('differs by category', () => {
		const a = fingerprintOf('peripheral', ['x']);
		const b = fingerprintOf('network', ['x']);
		expect(a).not.toBe(b);
	});
});

describe('recordFinding dedup', () => {
	it('first record creates a row, second with same fingerprint upserts and bumps last_seen_at', async () => {
		const fp = fingerprintOf('peripheral', ['ven-1', 'prod-1', 'sn-1']);
		const a = recordFinding({
			agentId: 'a-1', category: 'peripheral', severity: 'medium',
			title: 'USB MSD plugged in', evidence: { vendor: 'ven-1' }, fingerprint: fp
		});
		await new Promise(r => setTimeout(r, 1100));
		const b = recordFinding({
			agentId: 'a-1', category: 'peripheral', severity: 'medium',
			title: 'USB MSD plugged in', evidence: { vendor: 'ven-1' }, fingerprint: fp
		});
		expect(b.id).toBe(a.id);
		expect(b.firstSeenAt).toBe(a.firstSeenAt);
		expect(b.lastSeenAt >= a.lastSeenAt).toBe(true);
	});

	it('different fingerprint creates a new row', () => {
		const a = recordFinding({
			agentId: 'a-1', category: 'peripheral', severity: 'medium',
			title: 'A', evidence: {}, fingerprint: fingerprintOf('peripheral', ['a'])
		});
		const b = recordFinding({
			agentId: 'a-1', category: 'peripheral', severity: 'medium',
			title: 'B', evidence: {}, fingerprint: fingerprintOf('peripheral', ['b'])
		});
		expect(b.id).not.toBe(a.id);
	});

	it('same fingerprint on different agent makes a different row', () => {
		const fp = fingerprintOf('network', ['1.2.3.4']);
		const a = recordFinding({ agentId: 'a-1', category: 'network', severity: 'low', title: 'host', evidence: {}, fingerprint: fp });
		const b = recordFinding({ agentId: 'a-2', category: 'network', severity: 'low', title: 'host', evidence: {}, fingerprint: fp });
		expect(b.id).not.toBe(a.id);
	});

	it('resolved finding reopens on next record', () => {
		const fp = fingerprintOf('sensitive_data', ['/path/to/file']);
		const a = recordFinding({ agentId: 'a-1', category: 'sensitive_data', severity: 'high', title: 'creds', evidence: {}, fingerprint: fp });
		updateFindingState(a.id, 'resolved', 'u-1');
		const b = recordFinding({ agentId: 'a-1', category: 'sensitive_data', severity: 'high', title: 'creds again', evidence: {}, fingerprint: fp });
		expect(b.id).toBe(a.id);
		expect(b.state).toBe('open');
		expect(b.resolvedAt).toBe(null);
	});

	it('accepted finding stays accepted on next record', () => {
		const fp = fingerprintOf('peripheral', ['allowed-yubikey']);
		const a = recordFinding({ agentId: 'a-2', category: 'peripheral', severity: 'low', title: 'yk', evidence: {}, fingerprint: fp });
		updateFindingState(a.id, 'accepted', 'u-1');
		const b = recordFinding({ agentId: 'a-2', category: 'peripheral', severity: 'low', title: 'yk again', evidence: {}, fingerprint: fp });
		expect(b.state).toBe('accepted');
	});

	it('counts open findings by category', () => {
		const counts = getOpenFindingCounts();
		expect(counts.peripheral).toBeGreaterThanOrEqual(2);
		expect(counts.network).toBeGreaterThanOrEqual(2);
	});
});

describe('list filtering', () => {
	it('listFindingsByAgent returns only that agent', () => {
		const list1 = listFindingsByAgent('a-1');
		const list2 = listFindingsByAgent('a-2');
		expect(list1.every(f => f.agentId === 'a-1')).toBe(true);
		expect(list2.every(f => f.agentId === 'a-2')).toBe(true);
	});
});

describe('agent-collector-results', () => {
	it('record + getLatest returns the most recent', async () => {
		recordCollectorResult({ agentId: 'a-1', commandId: 'c-1', kind: 'reliability_daily', payload: { day: '2026-05-01', uptime: 86400 } });
		await new Promise(r => setTimeout(r, 1100));
		recordCollectorResult({ agentId: 'a-1', commandId: 'c-2', kind: 'reliability_daily', payload: { day: '2026-05-02', uptime: 86400 } });
		const latest = getLatestCollectorResult('a-1', 'reliability_daily');
		expect(latest?.payload.day).toBe('2026-05-02');
	});

	it('pruneOldCollectorResults runs without error', () => {
		const out = pruneOldCollectorResults();
		expect(Array.isArray(out)).toBe(true);
	});
});
