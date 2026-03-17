import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_STRINGS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../assets/templateStrings'
);

const ALLOWED_LANGUAGES = new Set(['en', 'de', 'fr', 'nl']);

const cache = new Map<string, Record<string, string>>();

/**
 * Load template i18n strings for a given language.
 * Falls back to English if the language file doesn't exist.
 */
export function getTemplateStrings(lang: string): Record<string, string> {
	// Sanitize: only allow known language codes to prevent path traversal
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