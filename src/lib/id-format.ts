import dayjs from 'dayjs';
import { incrementCounterWithMin } from '$lib/server/db.js';

/**
 * Counter keys live in db.ts seed list; keep this union in lockstep so a
 * typo can't silently spawn a new counter row at runtime.
 */
type CounterKey = 'invoice_global' | 'proposal_global' | 'client_global' | 'ticket_global' | 'agent_global';

/**
 * Atomically advance the named counter (respecting the configured minimum)
 * and produce the next document ID per the format string. Used by invoice,
 * proposal, and ticket-converted-to-invoice flows.
 */
export function generateNumberedId(
	counterKey: CounterKey,
	settings: { idFormat: string; nextNumber: number },
	clientName?: string
): string {
	const counter = incrementCounterWithMin(counterKey, settings.nextNumber);
	return resolveIdFormat(settings.idFormat, counter, new Date(), clientName);
}

/**
 * Resolve an ID format string into a document ID.
 *
 * Supported tokens:
 *   {YYYY}       — 4-digit year
 *   {YY}         — 2-digit year
 *   {MM}         — 2-digit month
 *   {DD}         — 2-digit day
 *   {####}       — Global sequential counter (padded to # count)
 *   {clientName} — Client name (for invoice/proposal formats)
 *
 * Examples:
 *   "{YYYY}-{####}" with counter=42 → "2026-0042"
 *   "{clientName}-{####}" with clientName="Acme", counter=7 → "Acme-0007"
 */
export function resolveIdFormat(
	format: string,
	counter: number,
	date: Date = new Date(),
	clientName?: string
): string {
	const d = dayjs(date);
	let result = format;

	// Date tokens
	result = result.replace(/{YYYY}/g, d.format('YYYY'));
	result = result.replace(/{YY}/g, d.format('YY'));
	result = result.replace(/{MM}/g, d.format('MM'));
	result = result.replace(/{DD}/g, d.format('DD'));

	// Client name token — sanitize to prevent special chars in document IDs.
	// Preserve Unicode letters/numbers for international names (e.g., "München GmbH").
	if (clientName !== undefined) {
		const safeName = clientName.replace(/[^\p{L}\p{N} _.-]/gu, '').trim() || 'Client';
		result = result.replace(/{clientName}/g, safeName);
	}

	// Counter tokens: {####} (global counter, padded to # count)
	result = result.replace(/{(#+)}/g, (_match, hashes: string) => {
		const padLength = hashes.length;
		return String(counter).padStart(padLength, '0');
	});

	return result;
}

/**
 * Generate a preview of what an ID format will produce.
 */
export function previewIdFormat(
	format: string,
	counter: number = 1,
	clientName: string = 'Client'
): string {
	return resolveIdFormat(format, counter, new Date(), clientName);
}
