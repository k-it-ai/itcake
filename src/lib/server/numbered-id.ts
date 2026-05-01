import { incrementCounterWithMin } from './db.js';
import { resolveIdFormat } from '$lib/id-format.js';

/**
 * Counter keys live in db.ts seed list; keep this union in lockstep so a
 * typo can't silently spawn a new counter row at runtime.
 */
type CounterKey = 'invoice_global' | 'proposal_global' | 'client_global' | 'ticket_global' | 'agent_global';

/**
 * Atomically advance the named counter (respecting the configured minimum)
 * and produce the next document ID per the format string. Used by invoice,
 * proposal, and ticket-converted-to-invoice flows.
 *
 * Server-only — wraps `incrementCounterWithMin` from db.ts. Pure formatting
 * lives in `$lib/id-format.ts` so the settings UI can preview without
 * touching the database.
 */
export function generateNumberedId(
	counterKey: CounterKey,
	settings: { idFormat: string; nextNumber: number },
	clientName?: string
): string {
	const counter = incrementCounterWithMin(counterKey, settings.nextNumber);
	return resolveIdFormat(settings.idFormat, counter, new Date(), clientName);
}
