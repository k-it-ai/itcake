/**
 * Regression tests for the second-pass security review findings:
 *
 * 1. `approveToolExecution` TOCTOU — the UPDATE must include
 *    `AND status = 'pending'` so a duplicate approve loses the race
 *    deterministically instead of overwriting a completed/rejected row.
 *
 * 2. Plan execution-window — an approved plan auto-executes for at
 *    most `PLAN_EXECUTION_WINDOW_MS` after approval. Beyond that the
 *    matcher refuses, so a partially-executed plan can't be replayed
 *    when the operator resumes the session days later.
 *
 * 3. `enc3:` ciphertexts redacted by the secret-stripper.
 *
 * 4. Unicode TAG block (U+E0000–U+E007F) stripped from AI input.
 *
 * 5. `redactSensitiveInput` collapses values under sensitive key names
 *    regardless of their string format.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-ai-second-pass');

let approveToolExecution: typeof import('../../src/services/ai-session.js').approveToolExecution;
let getToolExecution: typeof import('../../src/services/ai-session.js').getToolExecution;
let startSession: typeof import('../../src/services/ai-session.js').startSession;
let db: typeof import('../../src/lib/server/db.js').db;
let randomId: () => string;
let buildPlan: typeof import('../../src/lib/server/ai/plan-mode.js').buildPlan;
let setActivePlan: typeof import('../../src/lib/server/ai/plan-mode.js').setActivePlan;
let approvePlan: typeof import('../../src/lib/server/ai/plan-mode.js').approvePlan;
let matchPlanStep: typeof import('../../src/lib/server/ai/plan-mode.js').matchPlanStep;
let abortOrphanedPlans: typeof import('../../src/lib/server/ai/plan-mode.js').abortOrphanedPlans;
let _resetPlanCacheForTests: typeof import('../../src/lib/server/ai/plan-mode.js')._resetPlanCacheForTests;
let PLAN_EXECUTION_WINDOW_MS: number;
let redactSensitiveInput: typeof import('../../src/lib/server/ai/compaction.js').redactSensitiveInput;
let compactToolResultForChat: typeof import('../../src/lib/server/ai/compaction.js').compactToolResultForChat;
let sanitizeUserText: typeof import('../../src/lib/server/ai/sanitizer.js').sanitizeUserText;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'ai-2.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const sess = await import('../../src/services/ai-session.js');
	approveToolExecution = sess.approveToolExecution;
	getToolExecution = sess.getToolExecution;
	startSession = sess.startSession;
	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	const crypto = await import('node:crypto');
	randomId = () => crypto.randomBytes(8).toString('hex');

	// Enable the AI brain in the test DB so `startSession` works.
	// Use the strict-mode-friendly enabled+apiKey shape that aiSettingsSchema
	// accepts; no real API calls happen in these tests.
	dbMod.setSetting('ai', { enabled: true, apiKey: 'sk-ant-test-key-1234567890', model: 'haiku-4-5', monthlyBudgetCents: 5000, consultantMode: false });

	// `ai_sessions.user_id` has a FK to `users` — seed the test operator
	// row directly. `users` schema requires id, email, password_hash, totp.
	db.prepare(
		`INSERT OR IGNORE INTO users (id, email, password_hash, totp_secret) VALUES ('user-1', 'test@example.com', 'unused-bcrypt-hash', '')`
	).run();
	const plan = await import('../../src/lib/server/ai/plan-mode.js');
	buildPlan = plan.buildPlan;
	setActivePlan = plan.setActivePlan;
	approvePlan = plan.approvePlan;
	matchPlanStep = plan.matchPlanStep;
	abortOrphanedPlans = plan.abortOrphanedPlans;
	_resetPlanCacheForTests = plan._resetPlanCacheForTests;
	PLAN_EXECUTION_WINDOW_MS = plan.PLAN_EXECUTION_WINDOW_MS;
	const compact = await import('../../src/lib/server/ai/compaction.js');
	redactSensitiveInput = compact.redactSensitiveInput;
	compactToolResultForChat = compact.compactToolResultForChat;
	const san = await import('../../src/lib/server/ai/sanitizer.js');
	sanitizeUserText = san.sanitizeUserText;
});

beforeEach(() => {
	_resetPlanCacheForTests?.();
});

describe('approveToolExecution — TOCTOU', () => {
	function insertExecution(sessionId: string, messageId: string, status: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' = 'pending'): string {
		const id = randomId();
		db.prepare(
			`INSERT INTO ai_tool_executions (id, session_id, message_id, tool_name, tool_input, tier, status, approval_description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run(id, sessionId, messageId, 'dispatch_agent_command', JSON.stringify({ agentId: 'a-1' }), 3, status, 'desc');
		return id;
	}

	function insertSessionAndMessage(): { sessionId: string; messageId: string } {
		const sess = startSession('user-1', { approvalMode: 'per_step' });
		const messageId = randomId();
		db.prepare(
			`INSERT INTO ai_messages (id, session_id, role, content_blocks) VALUES (?, ?, 'user', ?)`
		).run(messageId, sess.id, JSON.stringify([{ type: 'text', text: 'hi' }]));
		return { sessionId: sess.id, messageId };
	}

	it('rejects a second approve on the same execution (lost race)', () => {
		const { sessionId, messageId } = insertSessionAndMessage();
		const execId = insertExecution(sessionId, messageId, 'pending');

		// First approve wins.
		expect(approveToolExecution(execId, 'approved', 'user-1')).toBe(true);

		// Second approve must lose — the WHERE-status='pending' guard
		// means the UPDATE finds no row and `res.changes` is 0.
		expect(approveToolExecution(execId, 'rejected', 'user-1')).toBe(false);

		const final = getToolExecution(execId);
		expect(final?.status).toBe('approved');
		expect(final?.approvedBy).toBe('user-1');
	});

	it('rejects an approve on a row whose status is no longer pending', () => {
		const { sessionId, messageId } = insertSessionAndMessage();
		const execId = insertExecution(sessionId, messageId, 'pending');

		// Simulate the handler completing the execution after approval.
		db.prepare(
			`UPDATE ai_tool_executions SET status = 'completed', result_summary = 'done' WHERE id = ?`
		).run(execId);

		// Now a duplicate approve attempt must NOT overwrite the 'completed' status.
		expect(approveToolExecution(execId, 'rejected', 'user-1')).toBe(false);
		expect(getToolExecution(execId)?.status).toBe('completed');
	});
});

describe('matchPlanStep — execution-window timeout', () => {
	it('refuses to match an approved plan after the execution window expires', () => {
		const built = buildPlan('sess-window-1', [
			{ toolName: 'list_agents', input: {}, rationale: 'enumerate' }
		]);
		setActivePlan('sess-window-1', built);
		const approved = approvePlan('sess-window-1', 'user-1');
		expect(approved).toBeTruthy();

		// Forge an approvedAt timestamp older than the execution window.
		const stale: typeof approved = {
			...approved!,
			approvedAt: new Date(Date.now() - PLAN_EXECUTION_WINDOW_MS - 60_000).toISOString()
		};
		const r = matchPlanStep(stale!, 'list_agents', {});
		expect(r.matched).toBe(false);
		expect(r.reason).toMatch(/execution window expired/);
	});

	it('still matches a fresh approval inside the window', () => {
		const built = buildPlan('sess-window-2', [
			{ toolName: 'list_agents', input: {}, rationale: 'enumerate' }
		]);
		setActivePlan('sess-window-2', built);
		const approved = approvePlan('sess-window-2', 'user-1');
		expect(approved).toBeTruthy();

		const r = matchPlanStep(approved!, 'list_agents', {});
		expect(r.matched).toBe(true);
	});

	it('abortOrphanedPlans reaps a stale `approved` plan', () => {
		const session = startSession('user-1', { approvalMode: 'per_step' });
		const stalePlan = {
			id: 'plan-stale-1', sessionId: session.id, steps: [{ index: 0, toolName: 'list_agents', input: {}, rationale: 'x' }],
			state: 'approved' as const, currentStepIndex: 0, approvedAt: new Date(Date.now() - PLAN_EXECUTION_WINDOW_MS - 5 * 60_000).toISOString(),
			approvedBy: 'user-1', proposedAt: new Date(Date.now() - PLAN_EXECUTION_WINDOW_MS - 6 * 60_000).toISOString(),
			rejectedAt: null, completedAt: null, deviationCount: 0
		};
		db.prepare('UPDATE ai_sessions SET plan_steps = ? WHERE id = ?').run(JSON.stringify(stalePlan), session.id);
		const aborted = abortOrphanedPlans();
		expect(aborted).toBeGreaterThanOrEqual(1);
		const row = db.prepare('SELECT plan_steps FROM ai_sessions WHERE id = ?').get(session.id) as { plan_steps: string };
		expect(JSON.parse(row.plan_steps).state).toBe('aborted');
	});
});

describe('SECRET_PATTERNS — enc3 blob coverage', () => {
	it('redacts an enc3: ciphertext inside a string', () => {
		const sample = 'foo enc3:AAAABBBBccccddddEEEEffff1234567890AbCdEf bar';
		const result = compactToolResultForChat(sample);
		expect(result.json).toContain('[REDACTED:itcake-encrypted-blob]');
		expect(result.json).not.toContain('enc3:AAAA');
	});

	it('redacts enc2: legacy blobs too', () => {
		const sample = 'before enc2:zzzz1111yyyy2222xxxx3333wwww4444 after';
		const result = compactToolResultForChat(sample);
		expect(result.json).toContain('[REDACTED:itcake-encrypted-blob]');
	});

	it('redacts enc3: when buried in a nested object value', () => {
		const input = { agent: { id: 'a-1', secret: 'enc3:AAAABBBBccccdddd1234567890abcdef0' } };
		const out = redactSensitiveInput(input) as { agent: { secret: string } };
		// SENSITIVE_KEY_NAMES handles `secret` directly (key-name redaction).
		expect(out.agent.secret).toMatch(/REDACTED:sensitive-key:secret/);
	});
});

describe('redactSensitiveInput — sensitive key names', () => {
	it('redacts a value under `password` regardless of format', () => {
		const out = redactSensitiveInput({ user: 'alice', password: 'P@55w0rd-not-a-token' }) as { password: string };
		expect(out.password).toBe('[REDACTED:sensitive-key:password]');
	});

	it('redacts `apiKey`, `privateKey`, `hmacSecret`, `botToken`', () => {
		const out = redactSensitiveInput({
			apiKey: 'plain-non-token-apikey-string',
			privateKey: 'plain-string-not-pem',
			hmacSecret: 'abcdef',
			botToken: '1234:fakeTelegramToken'
		}) as Record<string, string>;
		expect(out.apiKey).toMatch(/REDACTED:sensitive-key:apiKey/);
		expect(out.privateKey).toMatch(/REDACTED:sensitive-key:privateKey/);
		expect(out.hmacSecret).toMatch(/REDACTED:sensitive-key:hmacSecret/);
		expect(out.botToken).toMatch(/REDACTED:sensitive-key:botToken/);
	});

	it('preserves an empty-string value (no redaction)', () => {
		const out = redactSensitiveInput({ password: '' }) as { password: string };
		expect(out.password).toBe('');
	});

	it('does not redact non-sensitive keys', () => {
		const out = redactSensitiveInput({ username: 'alice', email: 'a@example.com' }) as { username: string; email: string };
		expect(out.username).toBe('alice');
		expect(out.email).toBe('a@example.com');
	});
});

describe('sanitizeUserText — Unicode TAG block', () => {
	it('strips U+E0001 (LANGUAGE TAG)', () => {
		const tag = String.fromCodePoint(0xE0001);
		const r = sanitizeUserText(`hello${tag}world`);
		expect(r.rejected).toBe(false);
		expect(r.clean).toBe('helloworld');
	});

	it('strips a multi-character TAG-encoded payload (steganographic injection)', () => {
		// "inject" encoded as TAG-LATIN codepoints (U+E0060 + ASCII offset)
		const tagPayload = [...'inject'].map(c => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
		const r = sanitizeUserText(`hi ${tagPayload} there`);
		expect(r.rejected).toBe(false);
		expect(r.clean).toBe('hi  there');
		expect(r.clean).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
	});

	it('strips zero-width joiner alongside TAG chars (mixed-payload)', () => {
		const zwj = '‍';
		const tag = String.fromCodePoint(0xE0065);
		const r = sanitizeUserText(`a${zwj}b${tag}c`);
		expect(r.rejected).toBe(false);
		expect(r.clean).toBe('abc');
	});
});
