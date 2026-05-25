import { incrementCounterWithMin, operatorTodayAsDate } from './db.js';
import { resolveIdFormat } from '$lib/id-format.js';

type CounterKey = 'invoice_global' | 'proposal_global' | 'client_global' | 'ticket_global' | 'agent_global';

export function generateNumberedId(
	counterKey: CounterKey,
	settings: { idFormat: string; nextNumber: number },
	clientName?: string
): string {
	const counter = incrementCounterWithMin(counterKey, settings.nextNumber);
	// operatorTodayAsDate — resolves {year} in operator TZ, not server-local.
	return resolveIdFormat(settings.idFormat, counter, operatorTodayAsDate(), clientName);
}
