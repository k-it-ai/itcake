import dayjs from 'dayjs';

export function formatDate(dateStr: string | null | undefined, format: string = 'DD/MM/YYYY'): string {
	if (!dateStr) return '';
	const d = dayjs(dateStr);
	if (!d.isValid()) return '';
	return d.format(format);
}
