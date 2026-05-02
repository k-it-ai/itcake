import dayjs from 'dayjs';

export function resolveIdFormat(
	format: string,
	counter: number,
	date: Date = new Date(),
	clientName?: string
): string {
	const d = dayjs(date);
	let result = format;

	result = result.replace(/{YYYY}/g, d.format('YYYY'));
	result = result.replace(/{YY}/g, d.format('YY'));
	result = result.replace(/{MM}/g, d.format('MM'));
	result = result.replace(/{DD}/g, d.format('DD'));

	if (clientName !== undefined) {
		const safeName = clientName.replace(/[^\p{L}\p{N} _.-]/gu, '').trim() || 'Client';
		result = result.replace(/{clientName}/g, safeName);
	}

	result = result.replace(/{(#+)}/g, (_match, hashes: string) => {
		const padLength = hashes.length;
		return String(counter).padStart(padLength, '0');
	});

	return result;
}

export function previewIdFormat(
	format: string,
	counter: number = 1,
	clientName: string = 'Client'
): string {
	return resolveIdFormat(format, counter, new Date(), clientName);
}
