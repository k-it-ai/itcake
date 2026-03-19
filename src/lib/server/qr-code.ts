import { generate } from 'lean-qr';
import { toSvgDataURL } from 'lean-qr/extras/svg';

/**
 * Generate a SEPA EPC QR code as an SVG data URL.
 *
 * SEPA EPC QR code format (EPC069-12):
 * Line 1: BCD (service tag)
 * Line 2: 002 (version)
 * Line 3: 1 (encoding UTF-8)
 * Line 4: SCT (function)
 * Line 5: BIC
 * Line 6: Beneficiary name
 * Line 7: IBAN
 * Line 8: EUR{amount}
 * Line 9: (purpose code - empty)
 * Line 10: (reference)
 * Line 11: (text)
 * Line 12: (information)
 */
export function generateSepaQrCode(options: {
	name: string;
	iban: string;
	bic: string;
	amount: number; // in cents
	currency?: string; // EUR or CHF (SEPA EPC supports both)
	reference: string;
	text?: string;
}): string {
	if (options.amount <= 0) {
		throw new Error('SEPA EPC QR requires a positive amount');
	}
	const currency = options.currency === 'CHF' ? 'CHF' : 'EUR';
	// SEPA EPC spec limits amounts to 999,999,999.99
	const MAX_SEPA_AMOUNT_CENTS = 99_999_999_999;
	if (options.amount > MAX_SEPA_AMOUNT_CENTS) {
		throw new Error('Amount exceeds SEPA EPC limit of 999,999,999.99');
	}
	// SEPA EPC QR only supports EUR and CHF, both 2-decimal currencies
	const amountFormatted = (Math.round(options.amount) / 100).toFixed(2);

	// Strip ASCII control characters + DEL to prevent payload injection (EPC069-12 requires clean UTF-8)
	const clean = (s: string, maxLen: number) => s.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, maxLen);

	// IBAN: strip whitespace and validate basic format
	const cleanIban = options.iban.replace(/[\s\r\n]/g, '').toUpperCase();

	const payload = [
		'BCD',
		'002',
		'1',
		'SCT',
		clean(options.bic || '', 11),       // BIC: max 11 chars
		clean(options.name, 70),             // Beneficiary: max 70 chars (EPC069-12)
		cleanIban.slice(0, 34),              // IBAN: max 34 chars
		`${currency}${amountFormatted}`,
		'',
		clean(options.reference || '', 35),  // Reference: max 35 chars
		clean(options.text || '', 140),       // Text: max 140 chars
		''
	].join('\n');

	const qr = generate(payload);

	// Use SVG export — works in Node.js without Canvas
	return toSvgDataURL(qr);
}
