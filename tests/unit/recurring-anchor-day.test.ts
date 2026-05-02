import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * The recurring-invoice anchor-day fix (audit L1): when a monthly /
 * quarterly / yearly schedule starts on a day that doesn't exist in
 * every month (29, 30, 31), the next run date must be CLAMPED for that
 * month but not permanently lost. Without anchorDay, dayjs chaining
 * drifts: Jan 31 → Feb 28 → Mar 28 → Apr 28 ... and never returns to
 * the 31st. With anchorDay=31, the schedule re-anchors each month.
 */

const TEST_DIR = path.resolve('data-test-recurring-anchor');

let computeNextDate: typeof import('../../src/services/recurring-invoices.js').computeNextDate;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'recurring.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const m = await import('../../src/services/recurring-invoices.js');
	computeNextDate = m.computeNextDate;
});
describe('recurring computeNextDate — anchorDay drift fix', () => {
	it('preserves anchor day across short-month rollover (Jan 31 series)', () => {
		const anchor = 31;

		const feb = computeNextDate('2026-01-31', 'monthly', null, anchor);
		expect(feb).toBe('2026-02-28');

		const mar = computeNextDate(feb, 'monthly', null, anchor);
		expect(mar).toBe('2026-03-31');

		const apr = computeNextDate(mar, 'monthly', null, anchor);
		expect(apr).toBe('2026-04-30');

		const may = computeNextDate(apr, 'monthly', null, anchor);
		expect(may).toBe('2026-05-31');
	});

	it('handles leap-year February correctly with anchorDay=29', () => {
		const anchor = 29;
		expect(computeNextDate('2024-01-29', 'monthly', null, anchor)).toBe('2024-02-29');
		expect(computeNextDate('2025-01-29', 'monthly', null, anchor)).toBe('2025-02-28');
		expect(computeNextDate('2025-02-28', 'monthly', null, anchor)).toBe('2025-03-29');
	});

	it('quarterly + yearly schedules respect anchorDay too', () => {
		expect(computeNextDate('2026-01-31', 'quarterly', null, 31)).toBe('2026-04-30');
		expect(computeNextDate('2024-02-29', 'yearly', null, 29)).toBe('2025-02-28');
	});

	it('weekly + custom frequencies ignore anchorDay (date arithmetic only)', () => {
		expect(computeNextDate('2026-01-31', 'weekly', null, 31)).toBe('2026-02-07');
		expect(computeNextDate('2026-01-31', 'custom', 30, 31)).toBe('2026-03-02');
	});

	it('without anchorDay, drifts after the first short-month rollover (regression sanity)', () => {
		const feb = computeNextDate('2026-01-31', 'monthly', null);
		expect(feb).toBe('2026-02-28');
		const mar = computeNextDate(feb, 'monthly', null);
		expect(mar).toBe('2026-03-28');
	});
});
