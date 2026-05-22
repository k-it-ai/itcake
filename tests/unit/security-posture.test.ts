import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-security-posture');

let recordFinding: typeof import('../../src/services/agent-findings.js').recordFinding;
let fingerprintOf: typeof import('../../src/services/agent-findings.js').fingerprintOf;
let updateFindingState: typeof import('../../src/services/agent-findings.js').updateFindingState;
let getAgentSecurityPosture: typeof import('../../src/services/security-posture.js').getAgentSecurityPosture;
let _resetPostureCacheForTests: typeof import('../../src/services/security-posture.js')._resetPostureCacheForTests;
let invalidateAgentPostureCache: typeof import('../../src/services/security-posture.js').invalidateAgentPostureCache;
let getAgentSecurityPostureCached: typeof import('../../src/services/security-posture.js').getAgentSecurityPostureCached;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'posture.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const findingsMod = await import('../../src/services/agent-findings.js');
	const postureMod = await import('../../src/services/security-posture.js');
	const dbMod = await import('../../src/lib/server/db.js');
	recordFinding = findingsMod.recordFinding;
	fingerprintOf = findingsMod.fingerprintOf;
	updateFindingState = findingsMod.updateFindingState;
	getAgentSecurityPosture = postureMod.getAgentSecurityPosture;
	getAgentSecurityPostureCached = postureMod.getAgentSecurityPostureCached;
	_resetPostureCacheForTests = postureMod._resetPostureCacheForTests;
	invalidateAgentPostureCache = postureMod.invalidateAgentPostureCache;
	db = dbMod.db;

	db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('a-1', 'host-1', 'host-1', 'linux', 'amd64', 'tk-1')`).run();
	db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('a-2', 'host-2', 'host-2', 'linux', 'amd64', 'tk-2')`).run();
});

beforeEach(() => {
	_resetPostureCacheForTests();
	db.prepare("DELETE FROM agent_findings WHERE agent_id IN ('a-1', 'a-2')").run();
	db.prepare("DELETE FROM agent_collector_results WHERE agent_id IN ('a-1', 'a-2')").run();
});

describe('security posture aggregate score', () => {
	it('clean agent with no findings and no reliability data scores 85 (full categories, zero reliability)', () => {
		const p = getAgentSecurityPosture('a-1');
		// 25+20+15+15+10 = 85 from clean categories. Reliability 0/15 (no data).
		expect(p.score).toBe(85);
		expect(p.riskFactors).toContain('no reliability data collected yet');
		const reliability = p.components.find(c => c.key === 'reliability');
		expect(reliability?.earnedPoints).toBe(0);
	});

	it('critical sensitive_data finding deducts the full sensitive_data slice (25 pts)', () => {
		recordFinding({
			agentId: 'a-1',
			category: 'sensitive_data',
			severity: 'critical',
			title: 'AWS key in /home/user/.bash_history',
			evidence: { path: '/home/user/.bash_history' },
			fingerprint: fingerprintOf('sensitive_data', ['/home/user/.bash_history', 'aws_key'])
		});
		_resetPostureCacheForTests();
		const p = getAgentSecurityPosture('a-1');
		// Clean baseline 85, minus 25 for critical sensitive_data = 60.
		expect(p.score).toBe(60);
		const sd = p.components.find(c => c.key === 'sensitive_data');
		expect(sd?.earnedPoints).toBe(0);
		expect(sd?.openCount).toBe(1);
		expect(sd?.worstSeverity).toBe('critical');
	});

	it('low-severity peripheral finding deducts only 20% of category slice', () => {
		recordFinding({
			agentId: 'a-1',
			category: 'peripheral',
			severity: 'low',
			title: 'unknown USB seen briefly',
			evidence: { vendorId: '1234' },
			fingerprint: fingerprintOf('peripheral', ['1234', 'low'])
		});
		_resetPostureCacheForTests();
		const p = getAgentSecurityPosture('a-1');
		// Peripheral max 15, low deducts 20% = 3 pts → earned 12. Total 85-3=82.
		expect(p.score).toBe(82);
		const per = p.components.find(c => c.key === 'peripheral');
		expect(per?.earnedPoints).toBe(12);
	});

	it('worst severity wins when multiple findings exist in the same category', () => {
		recordFinding({
			agentId: 'a-1',
			category: 'policy',
			severity: 'low',
			title: 'a',
			evidence: {},
			fingerprint: fingerprintOf('policy', ['low'])
		});
		recordFinding({
			agentId: 'a-1',
			category: 'policy',
			severity: 'high',
			title: 'b',
			evidence: {},
			fingerprint: fingerprintOf('policy', ['high'])
		});
		_resetPostureCacheForTests();
		const p = getAgentSecurityPosture('a-1');
		const policy = p.components.find(c => c.key === 'policy');
		expect(policy?.worstSeverity).toBe('high');
		expect(policy?.openCount).toBe(2);
		// Policy max 20, high deducts 80% = 16 pts → earned 4. Total 85-16=69.
		expect(p.score).toBe(69);
	});

	it('resolved findings are excluded from the score', () => {
		const f = recordFinding({
			agentId: 'a-1',
			category: 'sensitive_data',
			severity: 'critical',
			title: 'x',
			evidence: {},
			fingerprint: fingerprintOf('sensitive_data', ['x'])
		});
		updateFindingState(f.id, 'resolved', 'user-test');
		_resetPostureCacheForTests();
		const p = getAgentSecurityPosture('a-1');
		// Back to clean baseline
		expect(p.score).toBe(85);
	});

	it('cache returns same object until invalidated', () => {
		recordFinding({
			agentId: 'a-2',
			category: 'network',
			severity: 'medium',
			title: 'n',
			evidence: {},
			fingerprint: fingerprintOf('network', ['n'])
		});
		const a = getAgentSecurityPostureCached('a-2');
		const b = getAgentSecurityPostureCached('a-2');
		expect(b).toBe(a);

		invalidateAgentPostureCache('a-2');
		const c = getAgentSecurityPostureCached('a-2');
		expect(c).not.toBe(a);
	});

	it('per-agent isolation — findings on a-2 do not affect a-1', () => {
		recordFinding({
			agentId: 'a-2',
			category: 'sensitive_data',
			severity: 'critical',
			title: 'on a-2',
			evidence: {},
			fingerprint: fingerprintOf('sensitive_data', ['on-a-2'])
		});
		_resetPostureCacheForTests();
		const p1 = getAgentSecurityPosture('a-1');
		const p2 = getAgentSecurityPosture('a-2');
		expect(p1.score).toBe(85);
		expect(p2.score).toBe(60);
	});

	it('riskFactors list is populated only for components with deductions', () => {
		recordFinding({
			agentId: 'a-1',
			category: 'filesystem',
			severity: 'low',
			title: 'large temp',
			evidence: {},
			fingerprint: fingerprintOf('filesystem', ['large-temp'])
		});
		_resetPostureCacheForTests();
		const p = getAgentSecurityPosture('a-1');
		expect(p.riskFactors.some(s => s.startsWith('filesystem'))).toBe(true);
		// Sensitive_data clean → no risk factor for it.
		expect(p.riskFactors.some(s => s.startsWith('sensitive'))).toBe(false);
	});

	it('deleting an agent drops its in-memory posture cache entry', async () => {
		const { deleteAgent } = await import('../../src/services/agents.js');

		// Seed an agent + a finding, then prime the cache.
		db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('a-del', 'host-del', 'host-del', 'linux', 'amd64', 'tk-del')`).run();
		recordFinding({
			agentId: 'a-del',
			category: 'network',
			severity: 'medium',
			title: 'cached-finding',
			evidence: {},
			fingerprint: fingerprintOf('network', ['del-1'])
		});
		const cached = getAgentSecurityPostureCached('a-del');
		expect(cached.score).toBeLessThan(85);

		// Without the explicit `invalidateAgentPostureCache(id)` call in
		// `deleteAgent`, the cache would still serve the pre-delete row to
		// any caller for up to 5 minutes — including a re-enrolled agent
		// that happens to land on the same id.
		expect(deleteAgent('a-del', 'system')).toBe(true);

		// Re-insert with the same id (mimics a re-enrollment / restore).
		db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('a-del', 'host-del-new', 'host-del-new', 'linux', 'amd64', 'tk-del-new')`).run();
		const fresh = getAgentSecurityPostureCached('a-del');
		expect(fresh).not.toBe(cached);
		expect(fresh.score).toBe(85);
	});
});
