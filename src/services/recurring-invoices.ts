import { getDocument, updateDocument, db, getSetting } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { createInvoice } from './invoices.js';
import dayjs from 'dayjs';
import type { Invoice, RecurringFrequency, InvoiceSettings } from '$lib/types.js';

const stmtGetDocData = db.prepare("SELECT data FROM documents WHERE id = ? AND type = 'invoice'");

/**
 * Compute the next recurrence date from the current run date.
 *
 * For month-based frequencies (monthly, quarterly, yearly), uses the original
 * anchor day-of-month to prevent month-end drift. Example: a monthly invoice
 * starting Jan 31 produces Feb 28, Mar 31, Apr 30 — always targeting the
 * original day or the last day of the month, whichever is smaller.
 * Without this, dayjs chaining drifts: Jan 31 → Feb 28 → Mar 28 → Apr 28...
 */
function computeNextDate(current: string, frequency: RecurringFrequency, customDays: number | null, anchorDay?: number): string {
	const d = dayjs(current);
	switch (frequency) {
		case 'weekly': return d.add(1, 'week').format('YYYY-MM-DD');
		case 'monthly': return advanceMonths(d, 1, anchorDay).format('YYYY-MM-DD');
		case 'quarterly': return advanceMonths(d, 3, anchorDay).format('YYYY-MM-DD');
		case 'yearly': return advanceMonths(d, 12, anchorDay).format('YYYY-MM-DD');
		case 'custom': return d.add(customDays ?? 30, 'day').format('YYYY-MM-DD');
		default: { const _exhaustive: never = frequency; throw new Error(`Unknown frequency: ${_exhaustive}`); }
	}
}

/**
 * Advance by N months, pinning to the anchor day-of-month.
 * If the target month has fewer days, uses the last day of that month.
 */
function advanceMonths(d: dayjs.Dayjs, months: number, anchorDay?: number): dayjs.Dayjs {
	const targetMonth = d.add(months, 'month');
	if (!anchorDay) return targetMonth;
	const daysInMonth = targetMonth.daysInMonth();
	const day = Math.min(anchorDay, daysInMonth);
	return targetMonth.date(day);
}

/** Atomically disable an expired recurring schedule with re-read to avoid stale writes. */
const disableExpiredRecurring = db.transaction((invoiceId: string, userId: string): void => {
	const fresh = getDocument<Invoice>(invoiceId, 'invoice');
	if (!fresh?.recurring?.enabled) return;
	const updated = {
		...fresh,
		recurring: { ...fresh.recurring, enabled: false },
		updatedAt: new Date().toISOString()
	};
	updateDocument(invoiceId, updated);
	recordChange('invoice', invoiceId, 'update', {
		'recurring.enabled': { old: true, new: false }
	}, userId);
});

/**
 * Process all recurring invoices that are due.
 * Finds invoices with recurring.enabled=true and recurring.nextRunDate <= today,
 * then creates new invoices from them.
 */
// SQL filter: only load invoices with recurring enabled and nextRunDate <= today
const stmtDueRecurring = db.prepare(`
	SELECT data FROM documents
	WHERE type = 'invoice'
	  AND json_extract(data, '$.recurring.enabled') = 1
	  AND json_extract(data, '$.recurring.nextRunDate') <= ?
`);

export function processDueRecurringInvoices(userId: string): number {
	const today = dayjs().format('YYYY-MM-DD');
	const rows = stmtDueRecurring.all(today) as { data: string }[];
	let count = 0;

	for (const row of rows) {
		const inv = JSON.parse(row.data) as Invoice;
		if (!inv.recurring?.enabled) continue; // defensive: SQL already filters

		try {
			// Skip missed dates: advance nextRunDate to the present, then generate
			// one invoice for today. No backlog of backdated invoices.
			skipMissedDates(inv.id, today);
			const result = processOneRecurring(inv, today, userId);
			if (result) count++;
		} catch (e) {
			console.error(`Failed to generate recurring invoice from ${inv.id}:`, e);
		}

		// Disable expired schedules — check if the NEXT scheduled run exceeds endDate,
		// not just whether endDate < today. This ensures the schedule is disabled immediately
		// after the last valid run instead of one cycle late.
		const fresh = getDocument<Invoice>(inv.id, 'invoice');
		if (fresh?.recurring?.enabled && fresh.recurring.endDate) {
			if (fresh.recurring.nextRunDate > fresh.recurring.endDate) {
				disableExpiredRecurring(inv.id, userId);
			}
		}
	}

	return count;
}

/**
 * Fast-forward nextRunDate past all missed dates up to (but not including) today.
 * Does not generate invoices for missed dates — just advances the schedule.
 * This avoids a backlog of backdated invoices after extended downtime.
 */
const skipMissedDates = db.transaction((invId: string, today: string): void => {
	const row = stmtGetDocData.get(invId) as { data: string } | undefined;
	if (!row) return;
	const current = JSON.parse(row.data) as Invoice;
	if (!current.recurring?.enabled) return;

	let nextRun = current.recurring.nextRunDate;
	// If already current (only one period behind or on schedule), nothing to skip
	const anchorDay = dayjs(nextRun).date();
	const oneAhead = computeNextDate(nextRun, current.recurring.frequency, current.recurring.customIntervalDays, anchorDay);
	if (oneAhead > today) return; // only one period overdue — no skipping needed

	// Advance nextRunDate until the NEXT computed date would be in the future
	let safety = 0;
	while (safety < 1000) {
		const candidate = computeNextDate(nextRun, current.recurring.frequency, current.recurring.customIntervalDays, anchorDay);
		if (candidate > today) break;
		nextRun = candidate;
		safety++;
	}
	if (safety >= 1000) {
		console.warn(`[recurring] Safety limit reached for invoice ${invId} — schedule may be misconfigured (frequency: ${current.recurring.frequency}, customIntervalDays: ${current.recurring.customIntervalDays})`);
	}

	if (nextRun !== current.recurring.nextRunDate) {
		const updated = {
			...current,
			recurring: { ...current.recurring, nextRunDate: nextRun },
			updatedAt: new Date().toISOString()
		};
		updateDocument(current.id, updated);
	}
});

/**
 * Process a single recurring invoice iteration.
 * Wrapped in db.transaction so createInvoice + updateDocument are atomic.
 * better-sqlite3 supports nested transactions via savepoints, so the inner
 * transaction in createInvoice (incrementCounterWithMin) works correctly.
 */
const processOneRecurringTx = db.transaction((invId: string, today: string, userId: string): boolean => {
	// Re-read to guard against concurrent runs
	const row = stmtGetDocData.get(invId) as { data: string } | undefined;
	if (!row) return false;
	const current = JSON.parse(row.data) as Invoice;
	if (!current.recurring?.enabled || current.recurring.nextRunDate > today) return false;
	// Don't generate invoices past the end date (endDate is inclusive)
	if (current.recurring.endDate && current.recurring.nextRunDate > current.recurring.endDate) return false;

	const issueDate = current.recurring.nextRunDate;
	const daysDiff = dayjs(current.dueDate).diff(dayjs(current.issueDate), 'day');
	const fallbackDays = getSetting<InvoiceSettings>('invoices').defaultPaymentTermDays ?? 30;
	const dueDate = dayjs(issueDate).add(daysDiff >= 0 ? daysDiff : fallbackDays, 'day').format('YYYY-MM-DD');

	const newInvoice = createInvoice({
		clientId: current.clientId,
		pricingMode: current.pricingMode,
		currency: current.currency,
		language: current.language,
		issueDate,
		dueDate,
		items: structuredClone(current.items),
		discounts: structuredClone(current.discounts),
		notes: current.notes,
		footerText: current.footerText,
		templateId: current.templateId,
		templateOptions: structuredClone(current.templateOptions),
		recurring: null,
		kleinunternehmerOverride: current.kleinunternehmer === true ? true : undefined
	}, userId);

	// Use the scheduled run date's day-of-month as the anchor to prevent month-end drift.
	// E.g. a run date on the 31st should recur on the 31st (or last day) of each month.
	// Using nextRunDate (not issueDate) ensures the anchor stays correct if the user
	// manually edits the schedule to a different day-of-month.
	const anchorDay = dayjs(current.recurring.nextRunDate).date();
	const nextDate = computeNextDate(current.recurring.nextRunDate, current.recurring.frequency, current.recurring.customIntervalDays, anchorDay);
	const updated = {
		...current,
		recurring: {
			...current.recurring,
			lastRunDate: today,
			nextRunDate: nextDate,
			generatedInvoiceIds: [...current.recurring.generatedInvoiceIds, newInvoice.id].slice(-100)
		},
		updatedAt: new Date().toISOString()
	};
	updateDocument(current.id, updated);
	return true;
});

function processOneRecurring(inv: Invoice, today: string, userId: string): boolean {
	return processOneRecurringTx(inv.id, today, userId);
}
