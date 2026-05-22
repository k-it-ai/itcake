import { db, getSetting, setSetting } from '$lib/server/db.js';
import { sendEmail } from '$services/emails.js';
import { log } from '$lib/server/log.js';
import type { AiSettings, UptimeSettings } from '$lib/types.js';

/**
 * Per-million-token pricing in dollars. Cost figures are kept in cents
 * everywhere else in itcake (see CLAUDE.md "money: integer cents") so we
 * convert to cents at record-time. Pricing is sourced from the model
 * catalog cached by the claude-api skill — keep in sync when models
 * change.
 */
// Keys must match aiSettingsSchema.model in validators.ts. Pinned by a test
// in tests/unit/security-fixes (validators.ts is client-safe so it can't
// import this module).
export const MODEL_PRICING_CENTS_PER_MILLION_TOKENS: Record<string, { input: number; output: number; cacheRead: number }> = {
	'claude-opus-4-7': { input: 1500, output: 7500, cacheRead: 150 },
	'claude-opus-4-6': { input: 1500, output: 7500, cacheRead: 150 },
	'claude-sonnet-4-6': { input: 300, output: 1500, cacheRead: 30 },
	'claude-haiku-4-5': { input: 100, output: 500, cacheRead: 10 }
};

const DEFAULT_PRICING = { input: 1500, output: 7500, cacheRead: 150 };

export interface UsageRecord {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

export function computeCostCents(model: string, usage: UsageRecord): number {
	const p = MODEL_PRICING_CENTS_PER_MILLION_TOKENS[model] ?? DEFAULT_PRICING;
	// Clamp each token count at 0 — a malformed SDK response or upstream
	// API change that ever returns a negative integer would otherwise let a
	// later turn deflate the month-to-date sum and slip past the budget.
	const input = Math.max(0, usage.inputTokens);
	const output = Math.max(0, usage.outputTokens);
	const cacheRead = Math.max(0, usage.cacheReadTokens);
	const cents =
		(input * p.input) / 1_000_000 +
		(output * p.output) / 1_000_000 +
		(cacheRead * p.cacheRead) / 1_000_000;
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
	// Clamp negatives at the storage boundary too — `computeCostCents` already
	// clamps for the cost calculation, but the raw token columns deserve the
	// same guard so a future bug-induced negative doesn't poison the daily
	// rollup.
	const inputTokens = Math.max(0, input.usage.inputTokens);
	const outputTokens = Math.max(0, input.usage.outputTokens);
	const cacheReadTokens = Math.max(0, input.usage.cacheReadTokens);
	const costCents = computeCostCents(input.model, {
		inputTokens, outputTokens, cacheReadTokens
	});
	stmtUpsertDaily.run(
		day,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		costCents
	);
	maybeFireBudgetAlert();
	return { costCents };
}

// Sends one email per calendar month when month-to-date crosses the
// operator-configured percent of monthlyBudgetCents. State (last-fired
// month + last-fired threshold) lives in ai.lastBudgetAlertMonth so a
// settings restore / off-by-one tick doesn't double-fire.
function maybeFireBudgetAlert(): void {
	const ai = getSetting<AiSettings & {
		budgetAlertPercent?: number;
		lastBudgetAlertMonth?: string;
	}>('ai');
	if (!ai || !ai.enabled) return;
	const pct = typeof ai.budgetAlertPercent === 'number' ? ai.budgetAlertPercent : 80;
	if (pct <= 0 || pct >= 100) return;
	const limit = ai.monthlyBudgetCents ?? 5000;
	if (limit <= 0) return;
	const month = monthToDateCostCents();
	const threshold = Math.floor((limit * pct) / 100);
	if (month < threshold) return;
	const monthKey = new Date().toISOString().slice(0, 7);
	if (ai.lastBudgetAlertMonth === monthKey) return;
	const uptime = getSetting<UptimeSettings>('uptime');
	if (!uptime?.emailAlerts || !uptime.alertEmail) return;
	const subject = `[ITCake] AI monthly budget ${pct}% threshold reached`;
	const body =
		`AI month-to-date spend has crossed the ${pct}% threshold.\n\n` +
		`Spend: ${(month / 100).toFixed(2)}\n` +
		`Limit: ${(limit / 100).toFixed(2)}\n` +
		`When spend hits 100% of the limit, new turns will be refused with "monthly budget exceeded".`;
	sendEmail({ to: uptime.alertEmail, subject, body }).catch(e => {
		log.error('[ai-budget-alert] email send failed', e);
	});
	setSetting('ai', { ...ai, lastBudgetAlertMonth: monthKey });
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
	atTurnCap?: boolean;
	alreadyInFlight?: boolean;
}

const stmtClaimTurnSlot = db.prepare(
	`INSERT INTO ai_cost_daily (day, input_tokens, output_tokens, cache_read_tokens, cost_cents, message_count)
	 VALUES (?, 0, 0, 0, 0, 0)
	 ON CONFLICT(day) DO NOTHING`
);

const stmtClaimTurnSession = db.prepare(
	`UPDATE ai_sessions SET turn_count = turn_count + 1, updated_at = datetime('now') WHERE id = ? AND turn_count < ?`
);

// CAS the in-flight slot on the same row in the same transaction as the
// turn-count bump. NULL → datetime('now') only succeeds for one of N
// concurrent callers; the rest see changes=0 and bail out with
// `alreadyInFlight: true`. The 10-minute staleness clause lets a crashed
// or hung turn auto-recover on the next POST so a process restart doesn't
// strand the session "in flight forever."
const stmtClaimInFlight = db.prepare(
	`UPDATE ai_sessions SET in_flight_started_at = datetime('now')
	 WHERE id = ?
	   AND (in_flight_started_at IS NULL
	        OR in_flight_started_at < datetime('now', '-10 minutes'))`
);

const stmtReleaseInFlight = db.prepare(
	`UPDATE ai_sessions SET in_flight_started_at = NULL WHERE id = ?`
);

// Wraps the budget check + per-session turn-cap CAS + in-flight slot CAS +
// a placeholder daily-rollup row write in one transaction so concurrent
// turns serialise on SQLite's write lock — closes both the read-then-write
// race on budget/turn-cap AND the "two POSTs branch the transcript" race
// where two clients each pass the turn-cap check and then write parallel
// assistant messages, corrupting the tool_use/tool_result pairing the SDK
// requires.
export const claimTurnSlotIfWithinBudget = db.transaction((opts: { sessionId: string; turnCap: number | null }): BudgetCheck => {
	const settings = getSetting<AiSettings>('ai');
	const limit = settings?.monthlyBudgetCents ?? 5000;
	const month = monthToDateCostCents();
	const within = month < limit;
	if (!within) {
		return { withinBudget: false, monthCents: month, limitCents: limit };
	}
	// In-flight CAS BEFORE the turn-count bump so a refused POST doesn't
	// burn a turn slot. Two concurrent POSTs at turnCount=49/turnCap=50
	// would otherwise both succeed past the in-flight check and the first
	// would burn the cap.
	const flightRes = stmtClaimInFlight.run(opts.sessionId);
	if (flightRes.changes !== 1) {
		return { withinBudget: false, monthCents: month, limitCents: limit, alreadyInFlight: true };
	}
	if (opts.turnCap != null && opts.turnCap > 0) {
		const res = stmtClaimTurnSession.run(opts.sessionId, opts.turnCap);
		if (res.changes !== 1) {
			// Release the in-flight slot we just claimed — we're not
			// proceeding, so future POSTs should be able to start a turn.
			stmtReleaseInFlight.run(opts.sessionId);
			return { withinBudget: false, monthCents: month, limitCents: limit, atTurnCap: true };
		}
	}
	const today = new Date().toISOString().slice(0, 10);
	stmtClaimTurnSlot.run(today);
	return { withinBudget: true, monthCents: month, limitCents: limit };
});

export function releaseInFlightTurn(sessionId: string): void {
	stmtReleaseInFlight.run(sessionId);
}

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

