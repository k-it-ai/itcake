import { describe, it, expect } from 'vitest';
import { parseCron, nextRunAt, nextCronRun } from '../../src/lib/server/cron.js';

function iso(y: number, m: number, d: number, h: number, mi: number): string {
	return new Date(Date.UTC(y, m - 1, d, h, mi)).toISOString();
}

describe('parseCron', () => {
	it('accepts every wildcard', () => {
		const spec = parseCron('* * * * *');
		expect(spec.minute.values.size).toBe(60);
		expect(spec.hour.values.size).toBe(24);
		expect(spec.dom.values.size).toBe(31);
		expect(spec.month.values.size).toBe(12);
		expect(spec.dow.values.size).toBe(7);
	});

	it('parses ranges and lists', () => {
		const spec = parseCron('0 9-17 * * 1,2,3,4,5');
		expect(spec.hour.values.size).toBe(9);
		expect(spec.dow.values.has(1)).toBe(true);
		expect(spec.dow.values.has(0)).toBe(false);
	});

	it('parses step expressions', () => {
		const spec = parseCron('*/15 * * * *');
		expect(Array.from(spec.minute.values).sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
	});

	it('treats Sunday as 0 even when written as 7', () => {
		const spec = parseCron('0 0 * * 7');
		expect(spec.dow.values.has(0)).toBe(true);
	});

	it.each([
		['', /5 fields/],
		['* * *', /5 fields/],
		['60 * * * *', /out of range/],
		['* 24 * * *', /out of range/],
		['* * 32 * *', /out of range/],
		['* * * 0 *', /out of range/],
		['* * * 13 *', /out of range/],
		['* * * * 8', /out of range/],
		['10-5 * * * *', /out of range/],
		['*/0 * * * *', /invalid step/]
	])('rejects "%s"', (expr, msg) => {
		expect(() => parseCron(expr)).toThrow(msg);
	});
});

describe('nextRunAt', () => {
	const FROM = new Date(iso(2026, 4, 24, 12, 0));

	it('rolls forward to the next firing minute', () => {
		// "every 5 minutes" → from 12:00 → next is 12:05.
		const spec = parseCron('*/5 * * * *');
		const next = nextRunAt(spec, FROM);
		expect(next.toISOString()).toBe(iso(2026, 4, 24, 12, 5));
	});

	it('handles hour boundary', () => {
		// "at minute 0" at 12:00 → already past minute 0, next is 13:00.
		const spec = parseCron('0 * * * *');
		const next = nextRunAt(spec, FROM);
		expect(next.toISOString()).toBe(iso(2026, 4, 24, 13, 0));
	});

	it('handles "daily 03:00"', () => {
		const spec = parseCron('0 3 * * *');
		const next = nextRunAt(spec, FROM);
		expect(next.toISOString()).toBe(iso(2026, 4, 25, 3, 0));
	});

	it('handles weekday-only', () => {
		// "Mondays at 09:00" — 2026-04-24 is a Friday, next Monday is 2026-04-27.
		const spec = parseCron('0 9 * * 1');
		const next = nextRunAt(spec, FROM);
		expect(next.toISOString()).toBe(iso(2026, 4, 27, 9, 0));
	});

	it('handles a specific day-of-month', () => {
		// "1st of the month at midnight" → 2026-05-01 00:00 from 2026-04-24 12:00.
		const spec = parseCron('0 0 1 * *');
		const next = nextRunAt(spec, FROM);
		expect(next.toISOString()).toBe(iso(2026, 5, 1, 0, 0));
	});

	it('honors POSIX day-OR rule when both DOM and DOW are set', () => {
		// Either the 15th OR a Sunday → from 2026-04-24 (Fri), next is
		// 2026-04-26 (Sunday) — sooner than 2026-05-15.
		const spec = parseCron('0 0 15 * 0');
		const next = nextRunAt(spec, FROM);
		expect(next.toISOString()).toBe(iso(2026, 4, 26, 0, 0));
	});

	it('crosses month + year boundaries cleanly', () => {
		// "Dec 31 23:59" from earlier in the year → end of year.
		const spec = parseCron('59 23 31 12 *');
		const next = nextRunAt(spec, FROM);
		expect(next.toISOString()).toBe(iso(2026, 12, 31, 23, 59));
	});

	it('throws on unsatisfiable expressions (Feb 31)', () => {
		expect(() => nextCronRun('0 0 31 2 *')).toThrow(/no firing time/);
	});

	it('moves forward exactly one minute when current minute matches', () => {
		// At 12:00 (FROM has seconds=0 but we re-set inside), running
		// "every minute" returns 12:01 — never the same input minute.
		const spec = parseCron('* * * * *');
		const next = nextRunAt(spec, FROM);
		expect(next.toISOString()).toBe(iso(2026, 4, 24, 12, 1));
	});
});
