// EU member state codes (as of 2024, 27 members)
const euCountries = new Set([
	'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
	'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
	'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'
]);

export function isEuCountry(countryCode: string): boolean {
	return euCountries.has(countryCode);
}

// Country names in English (default)
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

// German country names (only supported non-English locale)
const countryNamesDe: Record<string, string> = {
	AF: 'Afghanistan', AL: 'Albanien', DZ: 'Algerien', AD: 'Andorra', AO: 'Angola',
	AR: 'Argentinien', AM: 'Armenien', AU: 'Australien', AT: 'Österreich', AZ: 'Aserbaidschan',
	BA: 'Bosnien und Herzegowina', BE: 'Belgien', BG: 'Bulgarien', BR: 'Brasilien',
	BY: 'Belarus', CA: 'Kanada', CH: 'Schweiz', CL: 'Chile', CN: 'China',
	CO: 'Kolumbien', CY: 'Zypern', CZ: 'Tschechien', DE: 'Deutschland', DK: 'Dänemark',
	EE: 'Estland', EG: 'Ägypten', ES: 'Spanien', FI: 'Finnland', FR: 'Frankreich',
	GB: 'Vereinigtes Königreich', GE: 'Georgien', GR: 'Griechenland', HK: 'Hongkong',
	HR: 'Kroatien', HU: 'Ungarn', ID: 'Indonesien', IE: 'Irland', IL: 'Israel',
	IN: 'Indien', IS: 'Island', IT: 'Italien', JP: 'Japan', KR: 'Südkorea',
	LI: 'Liechtenstein', LT: 'Litauen', LU: 'Luxemburg', LV: 'Lettland',
	MD: 'Moldawien', ME: 'Montenegro', MK: 'Nordmazedonien', MT: 'Malta',
	MX: 'Mexiko', MY: 'Malaysia', NG: 'Nigeria', NL: 'Niederlande',
	NO: 'Norwegen', NZ: 'Neuseeland', PH: 'Philippinen', PL: 'Polen',
	PT: 'Portugal', RO: 'Rumänien', RS: 'Serbien', RU: 'Russland',
	SA: 'Saudi-Arabien', SE: 'Schweden', SG: 'Singapur', SI: 'Slowenien',
	SK: 'Slowakei', TH: 'Thailand', TR: 'Türkei', TW: 'Taiwan',
	UA: 'Ukraine', AE: 'Vereinigte Arabische Emirate', US: 'Vereinigte Staaten',
	ZA: 'Südafrika'
};

const langMaps: Record<string, Record<string, string>> = { en: countryNames, de: countryNamesDe };

export function getCountryName(code: string, lang = 'en'): string {
	return langMaps[lang]?.[code] ?? countryNames[code] ?? code;
}
