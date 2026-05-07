import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-cis-audit');
const CIS_AGENT = 'a-cis';

let processCisAuditResult: typeof import('../../src/services/cis-audit.js').processCisAuditResult;
let getCisAudit: typeof import('../../src/services/cis-audit.js').getCisAudit;
let listFindingsByAgent: typeof import('../../src/services/agent-findings.js').listFindingsByAgent;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'cis.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const cis = await import('../../src/services/cis-audit.js');
	const findings = await import('../../src/services/agent-findings.js');
	const dbMod = await import('../../src/lib/server/db.js');
	processCisAuditResult = cis.processCisAuditResult;
	getCisAudit = cis.getCisAudit;
	listFindingsByAgent = findings.listFindingsByAgent;
	db = dbMod.db;
	db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, token_hash) VALUES (?, ?, ?, 'linux', 'amd64', 'tk-cis')`).run(CIS_AGENT, 'h-cis', 'h-cis');
});

beforeEach(() => {
	db.prepare("DELETE FROM agent_findings WHERE agent_id = ?").run(CIS_AGENT);
	db.prepare("DELETE FROM agent_collector_results WHERE agent_id = ?").run(CIS_AGENT);
});

const passingPayload = {
	checkedAt: '2026-05-01T10:00:00Z',
	platform: 'linux',
	totalChecks: 3,
	passedChecks: 3,
	failedChecks: 0,
	notApplicable: 0,
	erroredChecks: 0,
	score: 100,
	findings: [
		{ checkId: '1.5.3', title: 'ASLR', severity: 'high', status: 'pass', message: '', evidence: 'kernel.randomize_va_space = 2' },
		{ checkId: '5.2.5', title: 'PermitRootLogin', severity: 'high', status: 'pass', message: '', evidence: 'permitrootlogin = no' },
		{ checkId: '3.4.1', title: 'Firewall', severity: 'high', status: 'pass', message: '', evidence: 'ufw active' }
	]
};

const mixedPayload = {
	checkedAt: '2026-05-01T11:00:00Z',
	platform: 'linux',
	totalChecks: 3,
	passedChecks: 1,
	failedChecks: 2,
	notApplicable: 0,
	erroredChecks: 0,
	score: 33,
	findings: [
		{ checkId: '1.5.3', title: 'ASLR', severity: 'high', status: 'pass', message: '', evidence: '' },
		{ checkId: '5.2.5', title: 'PermitRootLogin', severity: 'high', status: 'fail', message: 'permitrootlogin = yes', evidence: 'yes' },
		{ checkId: '3.4.1', title: 'Firewall', severity: 'high', status: 'fail', message: 'no firewall', evidence: '' }
	]
};

describe('cis-audit', () => {
	it('rejects empty/findings-less payloads', () => {
		processCisAuditResult('cmd-1', CIS_AGENT, { findings: [] });
		expect(getCisAudit(CIS_AGENT).latest).toBeNull();
	});

	it('rejects findings with invalid severity or status', () => {
		processCisAuditResult('cmd-1', CIS_AGENT, {
			...passingPayload,
			findings: [
				{ checkId: 'X', title: 't', severity: 'extreme', status: 'pass', message: '', evidence: '' },
				{ checkId: 'Y', title: 't', severity: 'high', status: 'unknown', message: '', evidence: '' }
			]
		});
		expect(getCisAudit(CIS_AGENT).latest).toBeNull();
	});

	it('records snapshot and emits no findings when all checks pass', () => {
		processCisAuditResult('cmd-1', CIS_AGENT, passingPayload);
		const v = getCisAudit(CIS_AGENT);
		expect(v.latest!.score).toBe(100);
		expect(v.latest!.findings).toHaveLength(3);

		const findings = listFindingsByAgent(CIS_AGENT, 50).filter(f => f.title.startsWith('CIS '));
		expect(findings).toHaveLength(0);
	});

	it('emits one finding per failing check, fingerprinted by checkId', () => {
		processCisAuditResult('cmd-1', CIS_AGENT, mixedPayload);
		const f = listFindingsByAgent(CIS_AGENT, 50).filter(x => x.title.startsWith('CIS '));
		expect(f).toHaveLength(2);
		expect(f.map(x => x.title).sort()).toEqual(['CIS 3.4.1: Firewall', 'CIS 5.2.5: PermitRootLogin'].sort());
		expect(f.every(x => x.severity === 'high')).toBe(true);
		expect(f.every(x => x.category === 'policy')).toBe(true);
	});

	it('re-running with the same failures dedups (one open finding per check)', () => {
		processCisAuditResult('cmd-1', CIS_AGENT, mixedPayload);
		processCisAuditResult('cmd-2', CIS_AGENT, mixedPayload);
		const f = listFindingsByAgent(CIS_AGENT, 50).filter(x => x.title.startsWith('CIS '));
		expect(f).toHaveLength(2);
	});

	it('history exposes both audits regardless of same-second insertion order', () => {
		processCisAuditResult('cmd-1', CIS_AGENT, mixedPayload);
		processCisAuditResult('cmd-2', CIS_AGENT, { ...passingPayload, checkedAt: '2026-05-01T12:00:00Z' });
		const v = getCisAudit(CIS_AGENT);
		expect(v.history).toHaveLength(2);
		const scores = v.history.map(h => h.score).sort((a, b) => a - b);
		expect(scores).toEqual([33, 100]);
	});

	it('severity mapping carries low/medium/high through to the finding', () => {
		const p = {
			...mixedPayload,
			findings: [
				{ checkId: 'L', title: 't-l', severity: 'low', status: 'fail', message: '', evidence: '' },
				{ checkId: 'M', title: 't-m', severity: 'medium', status: 'fail', message: '', evidence: '' },
				{ checkId: 'H', title: 't-h', severity: 'high', status: 'fail', message: '', evidence: '' }
			]
		};
		processCisAuditResult('cmd-1', CIS_AGENT, p);
		const f = listFindingsByAgent(CIS_AGENT, 50).filter(x => x.title.startsWith('CIS '));
		const bySev: Record<string, string> = {};
		for (const x of f) bySev[x.severity] = x.title;
		expect(bySev.low).toBeDefined();
		expect(bySev.medium).toBeDefined();
		expect(bySev.high).toBeDefined();
	});
});
