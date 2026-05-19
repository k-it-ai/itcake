/**
 * Server-side i18n helper for background tasks (notifications, recurring invoices, etc.)
 * that cannot access the reactive Svelte t() store.
 *
 * Usage: const st = serverT('de'); st('notify.isDown') → 'ist OFFLINE'
 */
import { en } from './en.js';
import { de } from './de.js';

const dictionaries: Record<string, Record<string, string>> = { en, de };

export function serverT(lang: string): (key: string, params?: Record<string, string | number>) => string {
	const dict = dictionaries[lang] || dictionaries['en'];
	return (key: string, params?: Record<string, string | number>): string => {
		let value = dict[key] ?? dictionaries['en'][key] ?? key;
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				value = value.replaceAll(`{${k}}`, String(v));
			}
		}
		return value;
	};
}
