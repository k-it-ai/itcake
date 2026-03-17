import dayjs from 'dayjs';

/**
 * Format a date string using the user's configured format.
 * Pass the format from `data.settings.general.dateFormat` (available via layout).
 */
export function formatDate(dateStr: string | null | undefined, format: string = 'DD/MM/YYYY'): string {
	if (!dateStr) return '';
	const d = dayjs(dateStr);
	if (!d.isValid()) return '';
	return d.format(format);
}
