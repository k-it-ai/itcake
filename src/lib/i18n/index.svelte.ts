import { en } from './en.js';
import { de } from './de.js';

type Translations = Record<string, string>;

const translations: Record<string, Translations> = { en, de };

let currentLang = $state('en');

export const i18n = {
	get lang() { return currentLang; },
	set lang(v: string) {
		if (v && translations[v]) currentLang = v;
	}
};

export function t(key: string, replacements?: Record<string, string | number>): string {
	const dict = translations[currentLang] || translations.en;
	let str = dict[key] || (translations.en as Translations)[key] || key;
	if (replacements) {
		for (const [k, v] of Object.entries(replacements)) {
			str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
		}
	}
	return str;
}
