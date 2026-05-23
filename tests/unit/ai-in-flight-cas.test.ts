/**
 * In-flight CAS on ai_sessions. Without this, two concurrent POSTs to the
 * same session both pass `claimTurnSlotIfWithinBudget`, both start their
 * own Anthropic stream, and both write parallel `assistant` messages —
 * forking the transcript and breaking the tool_use/tool_result pairing
 * the SDK expects on resume.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-ai-in-flight');

let db: typeof import('../../src/lib/server/db.js').db;
let claimTurnSlotIfWithinBudget: typeof import('../../src/lib/server/ai/cost-tracker.js').claimTurnSlotIfWithinBudget;
let releaseInFlightTurn: typeof import('../../src/lib/server/ai/cost-tracker.js').releaseInFlightTurn;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'inflight.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	db = (await import('../../src/lib/server/db.js')).db;
	const ct = await import('../../src/lib/server/ai/cost-tracker.js');
	claimTurnSlotIfWithinBudget = ct.claimTurnSlotIfWithinBudget;
	releaseInFlightTurn = ct.releaseInFlightTurn;

	db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)`).run('u1', 'u1@t', 'h');
	db.prepare(`INSERT INTO ai_sessions (id, user_id, model) VALUES (?, ?, ?)`).run('sess-1', 'u1', 'claude-opus-4-7');
});

describe('claimTurnSlotIfWithinBudget — in-flight CAS', () => {
	it('first claim wins; second is refused with alreadyInFlight', () => {
		const a = claimTurnSlotIfWithinBudget({ sessionId: 'sess-1', turnCap: 50 });
		expect(a.withinBudget).toBe(true);

		const b = claimTurnSlotIfWithinBudget({ sessionId: 'sess-1', turnCap: 50 });
		expect(b.alreadyInFlight).toBe(true);
		expect(b.withinBudget).toBe(false);

		releaseInFlightTurn('sess-1');
	});

	it('release allows the next claim to proceed', () => {
		const a = claimTurnSlotIfWithinBudget({ sessionId: 'sess-1', turnCap: 50 });
		expect(a.withinBudget).toBe(true);
		releaseInFlightTurn('sess-1');

		const b = claimTurnSlotIfWithinBudget({ sessionId: 'sess-1', turnCap: 50 });
		expect(b.withinBudget).toBe(true);
		releaseInFlightTurn('sess-1');
	});

	it('refused claim does NOT burn a turn slot', () => {
		// Reset turn_count to a known value.
		db.prepare(`UPDATE ai_sessions SET turn_count = 0, in_flight_started_at = NULL WHERE id = ?`).run('sess-1');

		const a = claimTurnSlotIfWithinBudget({ sessionId: 'sess-1', turnCap: 50 });
		expect(a.withinBudget).toBe(true);

		// Second claim refused — must NOT have bumped turn_count.
		const before = (db.prepare(`SELECT turn_count FROM ai_sessions WHERE id = ?`).get('sess-1') as { turn_count: number }).turn_count;
		const b = claimTurnSlotIfWithinBudget({ sessionId: 'sess-1', turnCap: 50 });
		expect(b.alreadyInFlight).toBe(true);
		const after = (db.prepare(`SELECT turn_count FROM ai_sessions WHERE id = ?`).get('sess-1') as { turn_count: number }).turn_count;
		expect(after).toBe(before);

		releaseInFlightTurn('sess-1');
	});

	it('stale in-flight (>10min) is auto-released by the next claim', () => {
		// Plant an old in-flight timestamp.
		db.prepare(`UPDATE ai_sessions SET in_flight_started_at = datetime('now', '-11 minutes') WHERE id = ?`).run('sess-1');
		const a = claimTurnSlotIfWithinBudget({ sessionId: 'sess-1', turnCap: 50 });
		expect(a.withinBudget).toBe(true);
		releaseInFlightTurn('sess-1');
	});

	it('hung in-flight (<10min) still blocks new claims', () => {
		// Recent (5 minutes) — still active.
		db.prepare(`UPDATE ai_sessions SET in_flight_started_at = datetime('now', '-5 minutes') WHERE id = ?`).run('sess-1');
		const a = claimTurnSlotIfWithinBudget({ sessionId: 'sess-1', turnCap: 50 });
		expect(a.alreadyInFlight).toBe(true);
		releaseInFlightTurn('sess-1');
	});

	it('atTurnCap rollback releases the in-flight slot we just claimed', () => {
		// Push turn_count to the cap.
		db.prepare(`UPDATE ai_sessions SET turn_count = 50, in_flight_started_at = NULL WHERE id = ?`).run('sess-1');

		const a = claimTurnSlotIfWithinBudget({ sessionId: 'sess-1', turnCap: 50 });
		expect(a.atTurnCap).toBe(true);
		expect(a.withinBudget).toBe(false);

		// Slot must be NULL so a future POST (after operator nudges turn_count
		// back) can claim cleanly.
		const row = db.prepare(`SELECT in_flight_started_at FROM ai_sessions WHERE id = ?`).get('sess-1') as { in_flight_started_at: string | null };
		expect(row.in_flight_started_at).toBeNull();
	});
});
