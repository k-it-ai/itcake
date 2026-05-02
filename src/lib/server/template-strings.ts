import fs from 'node:fs';
import path from 'node:path';

const TEMPLATE_STRINGS_DIR = path.resolve('assets/templateStrings');

const ALLOWED_LANGUAGES = new Set(['en', 'de']);

const cache = new Map<string, Record<string, string>>();

export function getTemplateStrings(lang: string): Record<string, string> {
	const safeLang = ALLOWED_LANGUAGES.has(lang) ? lang : 'en';
	if (cache.has(safeLang)) return cache.get(safeLang)!;

	let filePath = path.join(TEMPLATE_STRINGS_DIR, `${safeLang}.json`);
	if (!fs.existsSync(filePath)) {
		filePath = path.join(TEMPLATE_STRINGS_DIR, 'en.json');
	}

	if (!fs.existsSync(filePath)) {
		return {};
	}

	const strings = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	cache.set(safeLang, strings);
	return strings;
}