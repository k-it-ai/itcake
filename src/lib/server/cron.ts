// Minimal 5-field cron parser. Supports `*`, `N`, `N-M`, `N,M,...`, and `*/N`
// per field. Five fields in order: minute (0-59), hour (0-23), day-of-month
// (1-31), month (1-12), day-of-week (0-6, where 0 and 7 both mean Sunday).
//
// Implemented from scratch to avoid a third-party dep — the syntax we
// support is a strict subset of standard cron, well-defined and ~150 LOC.

interface FieldSpec {
	values: Set<number>;
}

interface CronSpec {
	minute: FieldSpec;
	hour: FieldSpec;
	dom: FieldSpec;
	month: FieldSpec;
	dow: FieldSpec;
	/** Original `*` flags — POSIX day matching depends on which fields were
	 *  unrestricted vs explicit. */
	domIsAny: boolean;
	dowIsAny: boolean;
}

/** Parse a non-negative decimal integer, rejecting `parseInt`'s lax
 *  behaviour ("5abc" → 5). The cron grammar must be strict so that
 *  silently-truncated values can't sneak past the field-range check. */
function strictInt(s: string): number {
	if (!/^\d+$/.test(s)) return NaN;
	return parseInt(s, 10);
}

function parseField(text: string, min: number, max: number): FieldSpec {
	const values = new Set<number>();
	const parts = text.split(',');
	for (const p of parts) {
		// Reject anything outside the cron field grammar at the part level
		// so we fail fast on garbage like "5abc" or "*/-1" before further
		// regex / parseInt work even runs.
		if (!/^(\*|\d+(-\d+)?)(\/\d+)?$/.test(p)) {
			throw new Error(`invalid cron field "${p}"`);
		}
		// Step: `*/N` or `M-N/S`.
		const stepMatch = p.match(/^(.+)\/(\d+)$/);
		const step = stepMatch ? strictInt(stepMatch[2]) : 1;
		const inner = stepMatch ? stepMatch[1] : p;
		if (!Number.isFinite(step) || step < 1) throw new Error(`invalid step in "${p}"`);

		let lo: number, hi: number;
		if (inner === '*') {
			lo = min; hi = max;
		} else if (inner.includes('-')) {
			const [a, b] = inner.split('-');
			lo = strictInt(a);
			hi = strictInt(b);
		} else {
			lo = hi = strictInt(inner);
		}
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
			throw new Error(`field "${p}" out of range [${min}, ${max}]`);
		}
		for (let v = lo; v <= hi; v += step) values.add(v);
	}
	if (values.size === 0) throw new Error(`empty field "${text}"`);
	return { values };
}

/**
 * Parse a 5-field cron expression. Throws on syntax / range errors so the
 * caller can return a 400 to the user with a clean message.
 */
export function parseCron(expr: string): CronSpec {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error('cron expression must have 5 fields: minute hour day-of-month month day-of-week');
	}
	const [m, h, dom, mon, dow] = parts;
	const minute = parseField(m, 0, 59);
	const hour = parseField(h, 0, 23);
	const domField = parseField(dom, 1, 31);
	const monthField = parseField(mon, 1, 12);
	const rawDow = parseField(dow, 0, 7);
	// Normalize Sunday: cron treats 0 and 7 both as Sunday.
	const dowValues = new Set<number>();
	for (const v of rawDow.values) dowValues.add(v === 7 ? 0 : v);
	return {
		minute,
		hour,
		dom: domField,
		month: monthField,
		dow: { values: dowValues },
		domIsAny: dom === '*',
		dowIsAny: dow === '*'
	};
}

/**
 * Compute the next firing time at-or-after `from` for the given cron spec.
 * `from` is rounded UP to the next whole minute first (we never re-fire on
 * the same minute as the input). Returns ISO 8601 in UTC.
 *
 * **All cron fields are evaluated in UTC**, not the operator's local time.
 * The schedule UI labels the cron input "(UTC)" so operators in non-UTC
 * timezones know to offset their expressions accordingly. Using UTC avoids
 * DST spring-forward / fall-back cron-skip-or-double-fire ambiguities for
 * free; the trade-off is that an operator who wants a backup at 09:00
 * Berlin time has to write `0 7 * * *` in summer / `0 8 * * *` in winter
 * — but that operator wouldn't have wanted a DST-shifting cron anyway.
 *
 * Per POSIX cron rules: when both day-of-month and day-of-week are
 * restricted (neither is `*`), the schedule fires when EITHER matches.
 * When both are `*`, every day matches. When one is `*`, it's treated as
 * "any" and the other constrains the day.
 */
export function nextRunAt(spec: CronSpec, from: Date = new Date()): Date {
	// Round up to the next whole minute (drop seconds + ms).
	const start = new Date(from);
	start.setSeconds(0, 0);
	start.setMinutes(start.getMinutes() + 1);

	// Hard cap: if we don't find a match within ~366 days the cron is
	// pathological (e.g. Feb 31). Defensive guard against infinite loops.
	const cap = new Date(start.getTime() + 367 * 24 * 60 * 60 * 1000);

	const now = new Date(start);
	while (now < cap) {
		const month = now.getUTCMonth() + 1;
		if (!spec.month.values.has(month)) {
			// Jump to first day of next valid month.
			now.setUTCMonth(now.getUTCMonth() + 1, 1);
			now.setUTCHours(0, 0, 0, 0);
			continue;
		}

		const domVal = now.getUTCDate();
		const dowVal = now.getUTCDay();
		const domMatches = spec.dom.values.has(domVal);
		const dowMatches = spec.dow.values.has(dowVal);
		// POSIX day-match rule:
		//   *  *   → every day
		//   *  N   → only matching days of week
		//   N  *   → only matching days of month
		//   N  N   → matching days-of-month OR matching days-of-week (union)
		let dayOk: boolean;
		if (spec.domIsAny && spec.dowIsAny) dayOk = true;
		else if (spec.domIsAny) dayOk = dowMatches;
		else if (spec.dowIsAny) dayOk = domMatches;
		else dayOk = domMatches || dowMatches;
		if (!dayOk) {
			now.setUTCDate(now.getUTCDate() + 1);
			now.setUTCHours(0, 0, 0, 0);
			continue;
		}

		const hour = now.getUTCHours();
		if (!spec.hour.values.has(hour)) {
			now.setUTCHours(hour + 1, 0, 0, 0);
			continue;
		}

		const minute = now.getUTCMinutes();
		if (!spec.minute.values.has(minute)) {
			now.setUTCMinutes(minute + 1, 0, 0);
			continue;
		}

		return now;
	}
	throw new Error('no firing time within 1 year — cron expression is unsatisfiable');
}

/** Convenience: parse + nextRunAt in one call. Throws on bad syntax. */
export function nextCronRun(expr: string, from: Date = new Date()): Date {
	return nextRunAt(parseCron(expr), from);
}
