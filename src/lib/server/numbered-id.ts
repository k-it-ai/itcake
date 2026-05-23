import { incrementCounterWithMin, operatorTodayAsDate } from './db.js';
import { resolveIdFormat } from '$lib/id-format.js';

type CounterKey = 'invoice_global' | 'proposal_global' | 'client_global' | 'ticket_global' | 'agent_global';

export function generateNumberedId(
	counterKey: CounterKey,
	settings: { idFormat: string; nextNumber: number },
	clientName?: string
): string {
	const counter = incrementCounterWithMin(counterKey, settings.nextNumber);
	// The {year} format token resolves off this Date — use the operator's
	// configured timezone so a server-local TZ ≠ operator TZ doesn't roll
	// the year a day early/late. Same shape as `markOverdueInvoices` and
	// `processDueRecurringInvoicesInner` already use.
	return resolveIdFormat(settings.idFormat, counter, operatorTodayAsDate(), clientName);
}
