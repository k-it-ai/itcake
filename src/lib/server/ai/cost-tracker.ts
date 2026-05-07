import { db, getSetting } from '$lib/server/db.js';
import type { AiSettings } from './types.js';

/**
 * Per-million-token pricing in dollars. Cost figures are kept in cents
 * everywhere else in itcake (see CLAUDE.md "money: integer cents") so we
 * convert to cents at record-time. Pricing is sourced from the model
 * catalog cached by the claude-api skill — keep in sync when models
 * change.
 */
// Pricing keys must be kept in sync with `aiSettingsSchema.model` in
// validators.ts — that schema is the source of truth for which models the
// operator can select. validators.ts is client-safe so it can't import this
// module, hence the manual sync; the test in tests/unit/security-fixes
// pins the relationship.
export const MODEL_PRICING_CENTS_PER_MILLION_TOKENS: Record<string, { input: number; output: number; cacheRead: number }> = {
	'claude-opus-4-7': { input: 500, output: 2500, cacheRead: 50 },
	'claude-opus-4-6': { input: 500, output: 2500, cacheRead: 50 },
	'claude-sonnet-4-6': { input: 300, output: 1500, cacheRead: 30 },
	'claude-haiku-4-5': { input: 100, output: 500, cacheRead: 10 }
};

const DEFAULT_PRICING = { input: 500, output: 2500, cacheRead: 50 };

export interface UsageRecord {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

export function computeCostCents(model: string, usage: UsageRecord): number {
	const p = MODEL_PRICING_CENTS_PER_MILLION_TOKENS[model] ?? DEFAULT_PRICING;
	const cents =
		(usage.inputTokens * p.input) / 1_000_000 +
		(usage.outputTokens * p.output) / 1_000_000 +
		(usage.cacheReadTokens * p.cacheRead) / 1_000_000;
	return Math.ceil(cents);
}

const stmtUpsertDaily = db.prepare(
	`INSERT INTO ai_cost_daily (day, input_tokens, output_tokens, cache_read_tokens, cost_cents, message_count)
	 VALUES (?, ?, ?, ?, ?, 1)
	 ON CONFLICT(day) DO UPDATE SET
	   input_tokens = input_tokens + excluded.input_tokens,
	   output_tokens = output_tokens + excluded.output_tokens,
	   cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
	   cost_cents = cost_cents + excluded.cost_cents,
	   message_count = message_count + 1,
	   updated_at = datetime('now')`
);

const stmtSumMonth = db.prepare(
	"SELECT COALESCE(SUM(cost_cents), 0) AS sum FROM ai_cost_daily WHERE day >= ?"
);

export interface RecordUsageInput {
	model: string;
	usage: UsageRecord;
	day?: string;
}

export function recordUsage(input: RecordUsageInput): { costCents: number } {
	const day = input.day ?? new Date().toISOString().slice(0, 10);
	const costCents = computeCostCents(input.model, input.usage);
	stmtUpsertDaily.run(
		day,
		input.usage.inputTokens,
		input.usage.outputTokens,
		input.usage.cacheReadTokens,
		costCents
	);
	return { costCents };
}

export function monthToDateCostCents(now: Date = new Date()): number {
	const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const day = firstOfMonth.toISOString().slice(0, 10);
	const row = stmtSumMonth.get(day) as { sum: number };
	return row.sum;
}

export interface BudgetCheck {
	withinBudget: boolean;
	monthCents: number;
	limitCents: number;
}

export function checkMonthlyBudget(): BudgetCheck {
	const settings = getSetting<AiSettings>('ai');
	const limit = settings?.monthlyBudgetCents ?? 5000;
	const month = monthToDateCostCents();
	return { withinBudget: month < limit, monthCents: month, limitCents: limit };
}

const stmtClaimTurnSlot = db.prepare(
	`INSERT INTO ai_cost_daily (day, input_tokens, output_tokens, cache_read_tokens, cost_cents, message_count)
	 VALUES (?, 0, 0, 0, 0, 0)
	 ON CONFLICT(day) DO NOTHING`
);

/**
 * E7 — close the read-then-write race in `checkMonthlyBudget` →
 * model call → `recordUsage`. Two concurrent turns at $49.50 against a
 * $50 budget would both pass the read and both run.
 *
 * This wraps the budget check + a placeholder row write in one
 * `BEGIN IMMEDIATE` transaction so concurrent callers serialise on
 * SQLite's write lock. The placeholder row is a no-op for cost (zero
 * cents), but ensures the transaction takes the write lock so the next
 * caller's check sees the freshly-anchored state.
 *
 * In practice Node + better-sqlite3 is single-process and this is
 * belt-and-braces, but it's also the right shape if the cap is ever
 * tightened to "≥ limit" (currently strict less-than).
 */
export const claimTurnSlotIfWithinBudget = db.transaction((): BudgetCheck => {
	const settings = getSetting<AiSettings>('ai');
	const limit = settings?.monthlyBudgetCents ?? 5000;
	const month = monthToDateCostCents();
	const within = month < limit;
	if (within) {
		const today = new Date().toISOString().slice(0, 10);
		stmtClaimTurnSlot.run(today);
	}
	return { withinBudget: within, monthCents: month, limitCents: limit };
});

export interface CostSummary {
	monthCents: number;
	limitCents: number;
	dailyBreakdown: Array<{ day: string; costCents: number; messages: number }>;
}

const stmtRecentDaily = db.prepare(
	"SELECT day, cost_cents, message_count FROM ai_cost_daily ORDER BY day DESC LIMIT 30"
);

export function getCostSummary(): CostSummary {
	const rows = stmtRecentDaily.all() as { day: string; cost_cents: number; message_count: number }[];
	return {
		monthCents: monthToDateCostCents(),
		limitCents: getSetting<AiSettings>('ai')?.monthlyBudgetCents ?? 5000,
		dailyBreakdown: rows.map(r => ({ day: r.day, costCents: r.cost_cents, messages: r.message_count }))
	};
}

// Used in tests to wipe state between runs.
export function _resetCostTrackerForTests(): void {
	db.prepare('DELETE FROM ai_cost_daily').run();
}

