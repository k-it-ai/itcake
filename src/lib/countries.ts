// EU member state codes (as of 2024, 27 members)
const euCountries = new Set([
	'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
	'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
	'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'
]);

export function isEuCountry(countryCode: string): boolean {
	return euCountries.has(countryCode);
}

// Cache Intl.DisplayNames instances per locale
const displayNamesCache = new Map<string, Intl.DisplayNames>();

function getDisplayNames(lang: string): Intl.DisplayNames {
	let dn = displayNamesCache.get(lang);
	if (!dn) {
		dn = new Intl.DisplayNames([lang], { type: 'region' });
		displayNamesCache.set(lang, dn);
	}
	return dn;
}

export function getCountryName(code: string, lang = 'en'): string {
	try {
		return getDisplayNames(lang).of(code) ?? code;
	} catch {
		// Fallback for invalid codes
		return code;
	}
}
