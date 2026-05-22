import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

const TEST_DIR = path.resolve('data-test-turn-cap-race');

let db: Database;
let claimTurnSlotIfWithinBudget: typeof import('../../src/lib/server/ai/cost-tracker.js').claimTurnSlotIfWithinBudget;
let releaseInFlightTurn: typeof import('../../src/lib/server/ai/cost-tracker.js').releaseInFlightTurn;
let _resetCostTrackerForTests: typeof import('../../src/lib/server/ai/cost-tracker.js')._resetCostTrackerForTests;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'turn-cap.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbModule = await import('../../src/lib/server/db.js');
	db = dbModule.db;
	setSetting = dbModule.setSetting;
	const cost = await import('../../src/lib/server/ai/cost-tracker.js');
	claimTurnSlotIfWithinBudget = cost.claimTurnSlotIfWithinBudget;
	releaseInFlightTurn = cost.releaseInFlightTurn;
	_resetCostTrackerForTests = cost._resetCostTrackerForTests;

	db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash) VALUES ('u-1', 'u@test', 'h')`).run();
	setSetting('ai', { enabled: true, monthlyBudgetCents: 100000, maxTurnsPerSession: 10 });
});

describe('claimTurnSlotIfWithinBudget enforces the per-session turn cap atomically', () => {
	it('returns atTurnCap on the call that would exceed the cap, even when invoked back-to-back', () => {
		_resetCostTrackerForTests();
		const sessionId = 's-cap-1';
		const turnCap = 5;
		// Seed at turnCap - 1 = 4 — exactly the boundary the live code hit.
		db.prepare(
			`INSERT INTO ai_sessions (id, user_id, model, approval_mode, page_context, turn_count)
			 VALUES (?, 'u-1', 'claude-opus-4-7', 'per_step', '{}', ?)`
		).run(sessionId, turnCap - 1);

		const first = claimTurnSlotIfWithinBudget({ sessionId, turnCap });
		expect(first.withinBudget).toBe(true);
		expect(first.atTurnCap).toBeFalsy();

		// Release the in-flight slot the first claim took. In the real
		// `postMessage` flow this happens in the outer try/finally as the
		// turn completes. Without releasing, the second claim would fail
		// on the in-flight CAS rather than the turn-cap CAS — the test is
		// after the turn-cap predicate.
		releaseInFlightTurn(sessionId);

		// Second call inside the same Node tick — better-sqlite3 is sync, so this
		// is the strongest "race" we can simulate. The first call's transaction
		// has already committed by now (db.transaction runs sync). The cleanly-
		// designed UPDATE-CAS predicate (`WHERE turn_count < ?`) is what actually
		// closes the race; this test verifies the predicate, not the scheduling.
		const second = claimTurnSlotIfWithinBudget({ sessionId, turnCap });
		expect(second.atTurnCap).toBe(true);
		expect(second.withinBudget).toBe(false);

		const row = db.prepare('SELECT turn_count FROM ai_sessions WHERE id = ?').get(sessionId) as { turn_count: number };
		expect(row.turn_count).toBe(turnCap);
	});

	it('treats turnCap=null as no cap (unbounded session)', () => {
		_resetCostTrackerForTests();
		const sessionId = 's-cap-null';
		db.prepare(
			`INSERT INTO ai_sessions (id, user_id, model, approval_mode, page_context, turn_count)
			 VALUES (?, 'u-1', 'claude-opus-4-7', 'per_step', '{}', 9999)`
		).run(sessionId);

		const r = claimTurnSlotIfWithinBudget({ sessionId, turnCap: null });
		expect(r.withinBudget).toBe(true);
		expect(r.atTurnCap).toBeFalsy();
		// turn_count untouched when no cap is supplied — caller's bumpUsage handles
		// counting in that mode (legacy path).
		const row = db.prepare('SELECT turn_count FROM ai_sessions WHERE id = ?').get(sessionId) as { turn_count: number };
		expect(row.turn_count).toBe(9999);
	});

	it('honours monthly budget before checking turn cap', () => {
		_resetCostTrackerForTests();
		// Spend over the budget so monthCents >= limit.
		setSetting('ai', { enabled: true, monthlyBudgetCents: 100, maxTurnsPerSession: 10 });
		const today = new Date().toISOString().slice(0, 10);
		db.prepare(
			`INSERT OR REPLACE INTO ai_cost_daily (day, input_tokens, output_tokens, cache_read_tokens, cost_cents, message_count)
			 VALUES (?, 0, 0, 0, 200, 1)`
		).run(today);

		const sessionId = 's-budget-blocked';
		db.prepare(
			`INSERT INTO ai_sessions (id, user_id, model, approval_mode, page_context, turn_count)
			 VALUES (?, 'u-1', 'claude-opus-4-7', 'per_step', '{}', 0)`
		).run(sessionId);

		const r = claimTurnSlotIfWithinBudget({ sessionId, turnCap: 10 });
		expect(r.withinBudget).toBe(false);
		expect(r.atTurnCap).toBeFalsy();
		const row = db.prepare('SELECT turn_count FROM ai_sessions WHERE id = ?').get(sessionId) as { turn_count: number };
		expect(row.turn_count).toBe(0);

		setSetting('ai', { enabled: true, monthlyBudgetCents: 100000, maxTurnsPerSession: 10 });
	});
});
