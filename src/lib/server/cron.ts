
interface FieldSpec {
	values: Set<number>;
}

interface CronSpec {
	minute: FieldSpec;
	hour: FieldSpec;
	dom: FieldSpec;
	month: FieldSpec;
	dow: FieldSpec;
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
		if (!/^(\*|\d+(-\d+)?)(\/\d+)?$/.test(p)) {
			throw new Error(`invalid cron field "${p}"`);
		}
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

export function nextRunAt(spec: CronSpec, from: Date = new Date()): Date {
	const start = new Date(from);
	// The loop body iterates in UTC (getUTCMonth/Hours/Minutes/etc.) so the
	// initial alignment must also be UTC. Mixing setSeconds (local) with
	// getUTCMinutes (UTC) silently misaligned by the local-timezone offset's
	// minute component in zones whose offset is not a whole minute boundary
	// (Nepal, Chatham — 45-minute offsets). UTC-only here keeps the
	// "5-field cron, UTC" docs line accurate everywhere.
	start.setUTCSeconds(0, 0);
	start.setUTCMinutes(start.getUTCMinutes() + 1);

	const cap = new Date(start.getTime() + 367 * 24 * 60 * 60 * 1000);

	const now = new Date(start);
	while (now < cap) {
		const month = now.getUTCMonth() + 1;
		if (!spec.month.values.has(month)) {
			now.setUTCMonth(now.getUTCMonth() + 1, 1);
			now.setUTCHours(0, 0, 0, 0);
			continue;
		}

		const domVal = now.getUTCDate();
		const dowVal = now.getUTCDay();
		const domMatches = spec.dom.values.has(domVal);
		const dowMatches = spec.dow.values.has(dowVal);
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

export function nextCronRun(expr: string, from: Date = new Date()): Date {
	return nextRunAt(parseCron(expr), from);
}
