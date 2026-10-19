import { getDocument, updateDocument, db, getSetting, operatorTodayDate } from '#lib/server/db.js';
import { recordChange } from '#lib/server/changes.js';
import { createInvoice } from './invoices.js';
import dayjs from 'dayjs';
import type { Invoice, RecurringFrequency, InvoiceSettings } from '#lib/types.js';

const stmtGetDocData = db.prepare("SELECT data FROM documents WHERE id = ? AND type = 'invoice'");

export function computeNextDate(current: string, frequency: RecurringFrequency, customDays: number | null, anchorDay?: number): string {
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

function advanceMonths(d: dayjs.Dayjs, months: number, anchorDay?: number): dayjs.Dayjs {
	const targetMonth = d.add(months, 'month');
	if (!anchorDay) return targetMonth;
	const daysInMonth = targetMonth.daysInMonth();
	const day = Math.min(anchorDay, daysInMonth);
	return targetMonth.date(day);
}

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

const stmtDueRecurring = db.prepare(`
	SELECT data FROM documents
	WHERE type = 'invoice'
	  AND json_extract(data, '$.recurring.enabled') = 1
	  AND json_extract(data, '$.recurring.nextRunDate') <= ?
`);

let recurringRunning = false;

export function processDueRecurringInvoices(userId: string): number {
	if (recurringRunning) return 0;
	recurringRunning = true;
	try {
		return processDueRecurringInvoicesInner(userId);
	} finally {
		recurringRunning = false;
	}
}

function processDueRecurringInvoicesInner(userId: string): number {
	// Per-row date so a long-running tick that crosses midnight in the
	// operator's timezone doesn't skip new-day rows or double-process old.
	const rows = stmtDueRecurring.all(operatorTodayDate()) as { data: string }[];
	let count = 0;

	for (const row of rows) {
		const inv = JSON.parse(row.data) as Invoice;
		if (!inv.recurring?.enabled) continue;
		const today = operatorTodayDate();

		try {
			skipMissedDates(inv.id, today, userId);
			if (processOneRecurringTx(inv.id, today, userId)) count++;
		} catch (e) {
			console.error(`Failed to generate recurring invoice from ${inv.id}:`, e);
		}

		const fresh = getDocument<Invoice>(inv.id, 'invoice');
		if (fresh?.recurring?.enabled && fresh.recurring.endDate) {
			if (fresh.recurring.nextRunDate > fresh.recurring.endDate) {
				disableExpiredRecurring(inv.id, userId);
			}
		}
	}

	return count;
}

const skipMissedDates = db.transaction((invId: string, today: string, userId: string): void => {
	const row = stmtGetDocData.get(invId) as { data: string } | undefined;
	if (!row) return;
	const current = JSON.parse(row.data) as Invoice;
	if (!current.recurring?.enabled) return;

	let nextRun = current.recurring.nextRunDate;
	const anchorDay = current.recurring.anchorDay ?? dayjs(nextRun).date();
	const oneAhead = computeNextDate(nextRun, current.recurring.frequency, current.recurring.customIntervalDays, anchorDay);
	if (oneAhead > today) return;

	let safety = 0;
	while (safety < 1000) {
		const candidate = computeNextDate(nextRun, current.recurring.frequency, current.recurring.customIntervalDays, anchorDay);
		if (candidate > today) break;
		nextRun = candidate;
		safety++;
	}
	if (safety >= 1000) {
		console.warn(`[recurring] Safety limit reached for invoice ${invId} — disabling (frequency: ${current.recurring.frequency}, customIntervalDays: ${current.recurring.customIntervalDays})`);
		const updated = {
			...current,
			recurring: { ...current.recurring, enabled: false, nextRunDate: nextRun },
			updatedAt: new Date().toISOString()
		};
		updateDocument(current.id, updated);
		recordChange('invoice', current.id, 'update', {
			'recurring.enabled': { old: true, new: false },
			'recurring.nextRunDate': { old: current.recurring.nextRunDate, new: nextRun },
			'recurring.disabledReason': { old: null, new: 'safety_limit_reached' }
		}, userId);
		return;
	}

	if (nextRun !== current.recurring.nextRunDate) {
		const skippedPeriods = safety;
		const updated = {
			...current,
			recurring: { ...current.recurring, nextRunDate: nextRun },
			updatedAt: new Date().toISOString()
		};
		updateDocument(current.id, updated);
		recordChange('invoice', current.id, 'update', {
			'recurring.nextRunDate': { old: current.recurring.nextRunDate, new: nextRun },
			'recurring.skippedPeriods': { old: 0, new: skippedPeriods }
		}, userId);
		if (skippedPeriods > 1) {
			console.warn(`[recurring] Invoice ${invId}: skipped ${skippedPeriods} periods — clock jump or long downtime suspected. Operator may need to bill manually for missed cycles.`);
		}
	}
});

const processOneRecurringTx = db.transaction((invId: string, today: string, userId: string): boolean => {
	const row = stmtGetDocData.get(invId) as { data: string } | undefined;
	if (!row) return false;
	const current = JSON.parse(row.data) as Invoice;
	if (!current.recurring?.enabled || current.recurring.nextRunDate > today) return false;
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
		kleinunternehmerOverride: current.kleinunternehmer ?? false
	}, userId);

	const anchorDay = current.recurring.anchorDay ?? dayjs(current.recurring.nextRunDate).date();
	const nextDate = computeNextDate(current.recurring.nextRunDate, current.recurring.frequency, current.recurring.customIntervalDays, anchorDay);
	const updated = {
		...current,
		recurring: {
			...current.recurring,
			anchorDay,
			lastRunDate: today,
			nextRunDate: nextDate,
			generatedInvoiceIds: [...current.recurring.generatedInvoiceIds, newInvoice.id].slice(-100)
		},
		updatedAt: new Date().toISOString()
	};
	updateDocument(current.id, updated);
	recordChange('invoice', current.id, 'update', {
		'recurring.lastRunDate': { old: current.recurring.lastRunDate, new: today },
		'recurring.nextRunDate': { old: current.recurring.nextRunDate, new: nextDate },
		'recurring.generatedInvoiceIds': { old: '[changed]', new: '[changed]' }
	}, userId);
	return true;
});
