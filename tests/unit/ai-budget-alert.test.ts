/**
 * Tests for the AI monthly-budget alert wired into recordUsage:
 * - fires once per month when month-to-date >= budgetAlertPercent of the
 *   monthly cap
 * - does NOT re-fire on subsequent same-month turns
 * - is gated by uptime.emailAlerts + alertEmail (operator chose the channel)
 *
 * sendEmail throws when SMTP isn't configured; the alert catches and logs.
 * We assert on the lastBudgetAlertMonth side-effect rather than email
 * dispatch to keep the test SMTP-free.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-ai-budget-alert');

let recordUsage: typeof import('../../src/lib/server/ai/cost-tracker.js').recordUsage;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;
let getSetting: typeof import('../../src/lib/server/db.js').getSetting;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'ba.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	setSetting = dbMod.setSetting;
	getSetting = dbMod.getSetting;
	const cost = await import('../../src/lib/server/ai/cost-tracker.js');
	recordUsage = cost.recordUsage;
});

function makeAiCostRow(day: string, costCents: number) {
	db.prepare(
		'INSERT OR REPLACE INTO ai_cost_daily (day, input_tokens, output_tokens, cache_read_tokens, cost_cents, message_count) VALUES (?, 0, 0, 0, ?, 1)'
	).run(day, costCents);
}

describe('AI budget alert (recordUsage side effect)', () => {
	it('does not fire when AI is disabled', () => {
		setSetting('ai', {
			enabled: false, apiKey: '', model: 'claude-opus-4-7',
			monthlyBudgetCents: 100, approvalMode: 'per_step',
			maxTurnsPerSession: 50, maxOutputTokensPerTurn: 16000,
			thinkingMode: 'adaptive', budgetAlertPercent: 80
		});
		setSetting('uptime', { telegram: { botToken: '', chatId: '', enabled: false }, emailAlerts: true, alertEmail: 'ops@test' });
		// Seed enough cost to cross the threshold this month.
		makeAiCostRow(new Date().toISOString().slice(0, 10), 200);
		recordUsage({ model: 'claude-opus-4-7', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } });
		const ai = getSetting<{ lastBudgetAlertMonth?: string }>('ai');
		expect(ai.lastBudgetAlertMonth).toBeUndefined();
	});

	it('fires when spend crosses the budgetAlertPercent threshold', () => {
		const ymd = new Date().toISOString().slice(0, 10);
		const ym = ymd.slice(0, 7);
		setSetting('ai', {
			enabled: true, apiKey: 'k', model: 'claude-opus-4-7',
			monthlyBudgetCents: 100, approvalMode: 'per_step',
			maxTurnsPerSession: 50, maxOutputTokensPerTurn: 16000,
			thinkingMode: 'adaptive', budgetAlertPercent: 80
		});
		// Reset alert state + cost rollup so this run is the first crossing.
		const ai0 = getSetting<{ lastBudgetAlertMonth?: string }>('ai');
		delete ai0.lastBudgetAlertMonth;
		setSetting('ai', ai0);
		db.prepare("DELETE FROM ai_cost_daily WHERE day >= ?").run(ym + '-01');
		makeAiCostRow(ymd, 85); // 85% of 100, > threshold 80

		recordUsage({ model: 'claude-opus-4-7', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } });

		const ai = getSetting<{ lastBudgetAlertMonth?: string }>('ai');
		expect(ai.lastBudgetAlertMonth).toBe(ym);
	});

	it('does NOT re-fire when invoked twice in the same month', () => {
		const ymd = new Date().toISOString().slice(0, 10);
		const ym = ymd.slice(0, 7);
		// The previous test already flipped lastBudgetAlertMonth.
		const ai = getSetting<{ lastBudgetAlertMonth?: string }>('ai');
		expect(ai.lastBudgetAlertMonth).toBe(ym);

		// Tamper the row to detect a re-set
		const beforeMonth = ai.lastBudgetAlertMonth;
		recordUsage({ model: 'claude-opus-4-7', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } });

		const after = getSetting<{ lastBudgetAlertMonth?: string }>('ai');
		expect(after.lastBudgetAlertMonth).toBe(beforeMonth);
	});

	it('respects budgetAlertPercent=0 (disabled)', () => {
		const ymd = new Date().toISOString().slice(0, 10);
		const ym = ymd.slice(0, 7);
		setSetting('ai', {
			enabled: true, apiKey: 'k', model: 'claude-opus-4-7',
			monthlyBudgetCents: 100, approvalMode: 'per_step',
			maxTurnsPerSession: 50, maxOutputTokensPerTurn: 16000,
			thinkingMode: 'adaptive', budgetAlertPercent: 0
		});
		db.prepare("DELETE FROM ai_cost_daily WHERE day >= ?").run(ym + '-01');
		makeAiCostRow(ymd, 95);
		const before = getSetting<{ lastBudgetAlertMonth?: string }>('ai');
		delete before.lastBudgetAlertMonth;
		setSetting('ai', before);

		recordUsage({ model: 'claude-opus-4-7', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } });

		const after = getSetting<{ lastBudgetAlertMonth?: string }>('ai');
		expect(after.lastBudgetAlertMonth).toBeUndefined();
	});
});
