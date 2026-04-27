import { describe, it, expect } from 'vitest';
import { computeNextDate } from '../../src/services/recurring-invoices.js';

/**
 * The recurring-invoice anchor-day fix (audit L1): when a monthly /
 * quarterly / yearly schedule starts on a day that doesn't exist in
 * every month (29, 30, 31), the next run date must be CLAMPED for that
 * month but not permanently lost. Without anchorDay, dayjs chaining
 * drifts: Jan 31 → Feb 28 → Mar 28 → Apr 28 ... and never returns to
 * the 31st. With anchorDay=31, the schedule re-anchors each month.
 */
describe('recurring computeNextDate — anchorDay drift fix', () => {
	it('preserves anchor day across short-month rollover (Jan 31 series)', () => {
		const anchor = 31;

		// Jan 31 → Feb 28 (or 29 in a leap year — 2026 is not a leap year)
		const feb = computeNextDate('2026-01-31', 'monthly', null, anchor);
		expect(feb).toBe('2026-02-28');

		// Feb 28 → Mar 31 (NOT Mar 28). This was the regression: without
		// the anchor, the chain stays at day 28 forever.
		const mar = computeNextDate(feb, 'monthly', null, anchor);
		expect(mar).toBe('2026-03-31');

		// Mar 31 → Apr 30 (clamped — April only has 30 days).
		const apr = computeNextDate(mar, 'monthly', null, anchor);
		expect(apr).toBe('2026-04-30');

		// Apr 30 → May 31 (back to anchor).
		const may = computeNextDate(apr, 'monthly', null, anchor);
		expect(may).toBe('2026-05-31');
	});

	it('handles leap-year February correctly with anchorDay=29', () => {
		const anchor = 29;
		// 2024-01-29 → 2024-02-29 (leap year, day 29 exists)
		expect(computeNextDate('2024-01-29', 'monthly', null, anchor)).toBe('2024-02-29');
		// 2025-01-29 → 2025-02-28 (non-leap, clamped)
		expect(computeNextDate('2025-01-29', 'monthly', null, anchor)).toBe('2025-02-28');
		// 2025-02-28 → 2025-03-29 (re-anchor)
		expect(computeNextDate('2025-02-28', 'monthly', null, anchor)).toBe('2025-03-29');
	});

	it('quarterly + yearly schedules respect anchorDay too', () => {
		// Quarterly: Jan 31 → Apr 30 (April has 30 days, anchor 31 clamped)
		expect(computeNextDate('2026-01-31', 'quarterly', null, 31)).toBe('2026-04-30');
		// Yearly: Feb 29 (2024 leap) → Feb 28 (2025 non-leap, clamped)
		expect(computeNextDate('2024-02-29', 'yearly', null, 29)).toBe('2025-02-28');
	});

	it('weekly + custom frequencies ignore anchorDay (date arithmetic only)', () => {
		// 7-day forward — anchor irrelevant.
		expect(computeNextDate('2026-01-31', 'weekly', null, 31)).toBe('2026-02-07');
		// 30-day custom forward — anchor irrelevant.
		expect(computeNextDate('2026-01-31', 'custom', 30, 31)).toBe('2026-03-02');
	});

	it('without anchorDay, drifts after the first short-month rollover (regression sanity)', () => {
		// Demonstrates WHY anchorDay exists: feeding the previous result
		// back into computeNextDate without an anchor permanently drops
		// to day 28 after Feb.
		const feb = computeNextDate('2026-01-31', 'monthly', null);
		expect(feb).toBe('2026-02-28');
		const mar = computeNextDate(feb, 'monthly', null);
		// No anchor → stuck at 28, NOT back to 31.
		expect(mar).toBe('2026-03-28');
	});
});
