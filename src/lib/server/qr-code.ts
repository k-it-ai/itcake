import { generate } from 'lean-qr';
import { toSvgDataURL } from 'lean-qr/extras/svg';

export function generateQrCodeDataUrl(text: string): string {
	return toSvgDataURL(generate(text));
}

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
	const MAX_SEPA_AMOUNT_CENTS = 99_999_999_999;
	if (options.amount > MAX_SEPA_AMOUNT_CENTS) {
		throw new Error('Amount exceeds SEPA EPC limit of 999,999,999.99');
	}
	const amountFormatted = (Math.round(options.amount) / 100).toFixed(2);

	const clean = (s: string, maxLen: number) => s.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, maxLen);

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

	return toSvgDataURL(qr);
}
