// EU member state codes (as of 2024, 27 members)
const euCountries = new Set([
	'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
	'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
	'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'
]);

export function isEuCountry(countryCode: string): boolean {
	return euCountries.has(countryCode);
}

// Country names in English (default). Other languages loaded from assets/countryCodes/
const countryNames: Record<string, string> = {
	AF: 'Afghanistan', AL: 'Albania', DZ: 'Algeria', AD: 'Andorra', AO: 'Angola',
	AR: 'Argentina', AM: 'Armenia', AU: 'Australia', AT: 'Austria', AZ: 'Azerbaijan',
	BA: 'Bosnia and Herzegovina', BE: 'Belgium', BG: 'Bulgaria', BR: 'Brazil',
	BY: 'Belarus', CA: 'Canada', CH: 'Switzerland', CL: 'Chile', CN: 'China',
	CO: 'Colombia', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany', DK: 'Denmark',
	EE: 'Estonia', EG: 'Egypt', ES: 'Spain', FI: 'Finland', FR: 'France',
	GB: 'United Kingdom', GE: 'Georgia', GR: 'Greece', HK: 'Hong Kong',
	HR: 'Croatia', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel',
	IN: 'India', IS: 'Iceland', IT: 'Italy', JP: 'Japan', KR: 'South Korea',
	LI: 'Liechtenstein', LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia',
	MD: 'Moldova', ME: 'Montenegro', MK: 'North Macedonia', MT: 'Malta',
	MX: 'Mexico', MY: 'Malaysia', NG: 'Nigeria', NL: 'Netherlands',
	NO: 'Norway', NZ: 'New Zealand', PH: 'Philippines', PL: 'Poland',
	PT: 'Portugal', RO: 'Romania', RS: 'Serbia', RU: 'Russia',
	SA: 'Saudi Arabia', SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia',
	SK: 'Slovakia', TH: 'Thailand', TR: 'Turkey', TW: 'Taiwan',
	UA: 'Ukraine', AE: 'United Arab Emirates', US: 'United States',
	ZA: 'South Africa'
};

import fs from 'node:fs';
import path from 'node:path';

const countryNameCache = new Map<string, Record<string, string>>();

// Allowlist: only load country name files for known language codes.
// Prevents path traversal via crafted lang values (e.g. "../../etc/foo").
const ALLOWED_COUNTRY_LANGS = new Set(['en', 'de']);

export function getCountryName(code: string, lang = 'en'): string {
	if (lang === 'en') {
		return countryNames[code] ?? code;
	}

	// Reject unknown languages to prevent path traversal
	const safeLang = ALLOWED_COUNTRY_LANGS.has(lang) ? lang : 'en';
	if (safeLang === 'en') {
		return countryNames[code] ?? code;
	}

	// Load country names for non-English languages from assets
	if (!countryNameCache.has(safeLang)) {
		try {
			const filePath = path.resolve(`assets/countryCodes/${safeLang}.json`);
			if (fs.existsSync(filePath)) {
				countryNameCache.set(safeLang, JSON.parse(fs.readFileSync(filePath, 'utf-8')));
			} else {
				countryNameCache.set(safeLang, {}); // Cache miss — fall back to English
			}
		} catch (e) {
			console.warn(`Failed to load country names for "${safeLang}":`, e instanceof Error ? e.message : e);
			countryNameCache.set(safeLang, {});
		}
	}

	const langNames = countryNameCache.get(safeLang)!;
	return langNames[code] ?? countryNames[code] ?? code;
}
