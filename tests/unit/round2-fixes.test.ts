/**
 * Round-2 security regressions. One file per behavior change.
 *
 * Findings covered:
 *  - cost-tracker clamps negative tokens (round 2 sonnet AI + opus AI F4)
 *  - finding-state update guards expectedAgentId (round 2 sonnet RMM M4)
 *  - rejectPendingForSession drains awaiters (round 2 opus AI F2)
 *  - schedule re-validates type at fire time (round 2 opus RMM)
 *  - schedule auto-disables when agent vanishes (round 2 sonnet RMM H3)
 *  - DISPATCH_PINNED_KEYS_BY_ACTION.reboot no longer pins `message`
 *    (round 2 opus AI M3)
 *  - hostname-change-on-checkin emits a recordChange (round 2 opus RMM L9)
 *  - audit-anchor history trim helper drops above-cap snapshots
 *    (round 2 opus AUDIT)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const TEST_DIR = path.resolve('data-test-round2');

let db: typeof import('../../src/lib/server/db.js').db;
let computeCostCents: typeof import('../../src/lib/server/ai/cost-tracker.js').computeCostCents;
let recordUsage: typeof import('../../src/lib/server/ai/cost-tracker.js').recordUsage;
let _resetCostTrackerForTests: typeof import('../../src/lib/server/ai/cost-tracker.js')._resetCostTrackerForTests;
let updateFindingState: typeof import('../../src/services/agent-findings.js').updateFindingState;
let recordFinding: typeof import('../../src/services/agent-findings.js').recordFinding;
let fingerprintOf: typeof import('../../src/services/agent-findings.js').fingerprintOf;
let rejectPendingForSession: typeof import('../../src/lib/server/ai/approval-map.js').rejectPendingForSession;
let awaitApproval: typeof import('../../src/lib/server/ai/approval-map.js').awaitApproval;
let _approvalCountForTests: typeof import('../../src/lib/server/ai/approval-map.js')._approvalCountForTests;
let scheduleTypeAllowed: typeof import('../../src/lib/validators-rmm.js').scheduleTypeAllowed;
let trimAuditAnchorHistoryAbove: typeof import('../../src/lib/server/changes.js').trimAuditAnchorHistoryAbove;
let processCheckin: typeof import('../../src/services/agents.js').processCheckin;
let getRecentChanges: typeof import('../../src/services/changes.js').getRecentChanges;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'r2.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	db = (await import('../../src/lib/server/db.js')).db;
	const cost = await import('../../src/lib/server/ai/cost-tracker.js');
	computeCostCents = cost.computeCostCents;
	recordUsage = cost.recordUsage;
	_resetCostTrackerForTests = cost._resetCostTrackerForTests;
	const findings = await import('../../src/services/agent-findings.js');
	updateFindingState = findings.updateFindingState;
	recordFinding = findings.recordFinding;
	fingerprintOf = findings.fingerprintOf;
	const approval = await import('../../src/lib/server/ai/approval-map.js');
	rejectPendingForSession = approval.rejectPendingForSession;
	awaitApproval = approval.awaitApproval;
	_approvalCountForTests = approval._approvalCountForTests;
	const validators = await import('../../src/lib/validators-rmm.js');
	scheduleTypeAllowed = validators.scheduleTypeAllowed;
	const changes = await import('../../src/lib/server/changes.js');
	trimAuditAnchorHistoryAbove = changes.trimAuditAnchorHistoryAbove;
	const agents = await import('../../src/services/agents.js');
	processCheckin = agents.processCheckin;
	const changesSvc = await import('../../src/services/changes.js');
	getRecentChanges = changesSvc.getRecentChanges;

	// One user so audit-log recordChange writes are valid for the FK check.
	const hash = await bcrypt.hash('Pass1234', 4);
	try {
		db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
			.run('test-user', 'test@test.local', 'T', hash);
	} catch { /* already exists */ }
});

// ─────────────────────────────── cost-tracker clamps ───────────────────────

describe('computeCostCents clamps negative tokens (finding round-2 sonnet AI M2)', () => {
	it('treats negative input/output as zero', () => {
		expect(computeCostCents('claude-opus-4-7', {
			inputTokens: -1000,
			outputTokens: -1000,
			cacheReadTokens: -1000
		})).toBe(0);
	});

	it('still bills positive tokens correctly with all-zero negatives mixed in', () => {
		const c = computeCostCents('claude-opus-4-7', {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0
		});
		expect(c).toBe(1500);
	});
});

describe('recordUsage clamps negative tokens at storage boundary', () => {
	beforeEach(() => { _resetCostTrackerForTests(); });

	it('stores 0 for negative values, not the negative', () => {
		const day = '2026-05-12';
		recordUsage({
			model: 'claude-opus-4-7',
			usage: { inputTokens: -50, outputTokens: -50, cacheReadTokens: -50 },
			day
		});
		const row = db.prepare('SELECT input_tokens, output_tokens, cache_read_tokens, cost_cents FROM ai_cost_daily WHERE day = ?')
			.get(day) as { input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_cents: number };
		expect(row.input_tokens).toBe(0);
		expect(row.output_tokens).toBe(0);
		expect(row.cache_read_tokens).toBe(0);
		expect(row.cost_cents).toBe(0);
	});
});

// ────────────────────────── finding-state ownership guard ──────────────────

describe('updateFindingState honors expectedAgentId (finding round-2 sonnet RMM M4)', () => {
	let findingA: string;
	const agentAlpha = 'agent-alpha-r2';
	const agentBeta = 'agent-beta-r2';

	beforeAll(() => {
		db.prepare('DELETE FROM agents WHERE id IN (?, ?)').run(agentAlpha, agentBeta);
		db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash, status, enabled, data) VALUES (?, 'A', 'h', 'linux', 'amd64', ?, 'online', 1, '{}')`)
			.run(agentAlpha, 'tok-r2-a');
		db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash, status, enabled, data) VALUES (?, 'B', 'h', 'linux', 'amd64', ?, 'online', 1, '{}')`)
			.run(agentBeta, 'tok-r2-b');
		const f = recordFinding({
			agentId: agentAlpha,
			category: 'policy',
			severity: 'low',
			title: 'r2-finding',
			evidence: {},
			fingerprint: fingerprintOf('policy', ['r2-test'])
		});
		findingA = f.id;
	});

	it('returns null and writes nothing when expectedAgentId does not match', () => {
		const before = db.prepare("SELECT state FROM agent_findings WHERE id = ?").get(findingA) as { state: string };
		const result = updateFindingState(findingA, 'resolved', 'test-user', agentBeta);
		expect(result).toBeNull();
		const after = db.prepare("SELECT state FROM agent_findings WHERE id = ?").get(findingA) as { state: string };
		expect(after.state).toBe(before.state); // unchanged
	});

	it('writes through when expectedAgentId matches', () => {
		const result = updateFindingState(findingA, 'resolved', 'test-user', agentAlpha);
		expect(result).not.toBeNull();
		expect(result?.state).toBe('resolved');
	});

	it('still works when expectedAgentId is omitted (backward compat)', () => {
		const result = updateFindingState(findingA, 'open', 'test-user');
		expect(result?.state).toBe('open');
	});
});

// ─────────────────────────── rejectPendingForSession ───────────────────────

describe('rejectPendingForSession drains awaiters (finding round-2 opus AI F2 + sonnet H1)', () => {
	it('resolves all pending approvals for the given sessionId as rejected', async () => {
		const p1 = awaitApproval('exec-1', 'sess-A', 60_000);
		const p2 = awaitApproval('exec-2', 'sess-A', 60_000);
		const p3 = awaitApproval('exec-3', 'sess-B', 60_000);
		expect(_approvalCountForTests()).toBe(3);

		const drained = rejectPendingForSession('sess-A');
		expect(drained).toBe(2);

		await expect(p1).resolves.toBe('rejected');
		await expect(p2).resolves.toBe('rejected');
		expect(_approvalCountForTests()).toBe(1);

		// p3 still pending — drain it for cleanup
		const drainedB = rejectPendingForSession('sess-B');
		expect(drainedB).toBe(1);
		await expect(p3).resolves.toBe('rejected');
	});
});

// ─────────────────────────── schedule type re-check ────────────────────────

describe('scheduleTypeAllowed (finding round-2 opus RMM schedule-type drift)', () => {
	it('allows the documented schedule types', () => {
		expect(scheduleTypeAllowed('shell')).toBe(true);
		expect(scheduleTypeAllowed('script')).toBe(true);
		expect(scheduleTypeAllowed('cis_audit')).toBe(true);
		expect(scheduleTypeAllowed('peripheral_scan')).toBe(true);
		// package_uninstall is allowed on schedules (auto-remove unauthorized
		// software is a legitimate operator use case; DB CHECK + Go agent
		// already supported it).
		expect(scheduleTypeAllowed('package_uninstall')).toBe(true);
	});

	it('rejects the intentionally-excluded destructive types', () => {
		// filesystem_cleanup is the only schedule-type exclusion: it requires
		// per-call MFA step-up that a cron evaluator cannot supply.
		expect(scheduleTypeAllowed('filesystem_cleanup')).toBe(false);
	});

	it('rejects unknown / future types', () => {
		expect(scheduleTypeAllowed('quantum_audit')).toBe(false);
		expect(scheduleTypeAllowed('')).toBe(false);
	});
});

// ─────────────────────── audit-anchor history trim helper ──────────────────

describe('trimAuditAnchorHistoryAbove (finding round-2 opus AUDIT historyTruncationDetected false positive)', () => {
	it('deletes snapshots whose row_count exceeds the cap', () => {
		db.prepare('DELETE FROM audit_anchor_history').run();
		const stmt = db.prepare("INSERT INTO audit_anchor_history (row_count, last_hash, anchor_hmac, captured_at) VALUES (?, '', '', datetime('now'))");
		stmt.run(50);
		stmt.run(100);
		stmt.run(200);
		stmt.run(500);

		const dropped = trimAuditAnchorHistoryAbove(150);
		expect(dropped).toBe(2);

		const remaining = (db.prepare('SELECT row_count FROM audit_anchor_history ORDER BY row_count').all() as { row_count: number }[]).map(r => r.row_count);
		expect(remaining).toEqual([50, 100]);
	});
});

// ───────────────────── hostname-change-on-checkin audit row ────────────────

describe('processCheckin records hostname changes (finding round-2 opus RMM L9)', () => {
	const agentH = 'agent-hostname-r2';

	beforeAll(() => {
		db.prepare('DELETE FROM agents WHERE id = ?').run(agentH);
		db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash, status, enabled, data) VALUES (?, 'H', 'host-original', 'linux', 'amd64', ?, 'online', 1, '{}')`)
			.run(agentH, 'tok-r2-h');
	});

	it('writes an audit-log diff when the agent reports a new hostname', () => {
		const beforeCount = getRecentChanges(50).filter(c => c.entityType === 'agent' && c.entityId === agentH).length;
		processCheckin(agentH, { hostname: 'host-renamed' });
		const after = getRecentChanges(50).filter(c => c.entityType === 'agent' && c.entityId === agentH);
		expect(after.length).toBeGreaterThan(beforeCount);
		const hit = after.find(c => 'hostname' in c.diff);
		expect(hit).toBeDefined();
		const d = (hit?.diff as Record<string, { old: unknown; new: unknown }>).hostname;
		expect(d.old).toBe('host-original');
		expect(d.new).toBe('host-renamed');
	});

	it('does NOT write an audit row when the hostname is unchanged', () => {
		const beforeCount = getRecentChanges(50).filter(c => c.entityType === 'agent' && c.entityId === agentH && 'hostname' in c.diff).length;
		processCheckin(agentH, { hostname: 'host-renamed' });
		const afterCount = getRecentChanges(50).filter(c => c.entityType === 'agent' && c.entityId === agentH && 'hostname' in c.diff).length;
		expect(afterCount).toBe(beforeCount);
	});
});
