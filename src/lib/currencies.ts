interface Currency {
	code: string;
	name: string;
	symbol: string;
	decimals: number;
}

const currencies: Currency[] = [
	{ code: 'EUR', name: 'Euro', symbol: '\u20AC', decimals: 2 },
	{ code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2 },
	{ code: 'GBP', name: 'British Pound', symbol: '\u00A3', decimals: 2 },
	{ code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', decimals: 2 },
	{ code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimals: 2 },
	{ code: 'AUD', name: 'Australian Dollar', symbol: 'A$', decimals: 2 },
	{ code: 'JPY', name: 'Japanese Yen', symbol: '\u00A5', decimals: 0 },
	{ code: 'CNY', name: 'Chinese Yuan', symbol: '\u00A5', decimals: 2 },
	{ code: 'SEK', name: 'Swedish Krona', symbol: 'kr', decimals: 2 },
	{ code: 'NOK', name: 'Norwegian Krone', symbol: 'kr', decimals: 2 },
	{ code: 'DKK', name: 'Danish Krone', symbol: 'kr', decimals: 2 },
	{ code: 'PLN', name: 'Polish Zloty', symbol: 'z\u0142', decimals: 2 },
	{ code: 'CZK', name: 'Czech Koruna', symbol: 'K\u010D', decimals: 2 },
	{ code: 'HUF', name: 'Hungarian Forint', symbol: 'Ft', decimals: 0 },
	{ code: 'RON', name: 'Romanian Leu', symbol: 'lei', decimals: 2 },
	{ code: 'BGN', name: 'Bulgarian Lev', symbol: '\u043B\u0432', decimals: 2 },
	{ code: 'RSD', name: 'Serbian Dinar', symbol: 'din', decimals: 2 },
	{ code: 'TRY', name: 'Turkish Lira', symbol: '\u20BA', decimals: 2 },
	{ code: 'RUB', name: 'Russian Ruble', symbol: '\u20BD', decimals: 2 },
	{ code: 'UAH', name: 'Ukrainian Hryvnia', symbol: '\u20B4', decimals: 2 },
	{ code: 'INR', name: 'Indian Rupee', symbol: '\u20B9', decimals: 2 },
	{ code: 'BRL', name: 'Brazilian Real', symbol: 'R$', decimals: 2 },
	{ code: 'MXN', name: 'Mexican Peso', symbol: 'MX$', decimals: 2 },
	{ code: 'ZAR', name: 'South African Rand', symbol: 'R', decimals: 2 },
	{ code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', decimals: 2 },
	{ code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', decimals: 2 },
	{ code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', decimals: 2 },
	{ code: 'KRW', name: 'South Korean Won', symbol: '\u20A9', decimals: 0 },
	{ code: 'TWD', name: 'New Taiwan Dollar', symbol: 'NT$', decimals: 2 },
	{ code: 'THB', name: 'Thai Baht', symbol: '\u0E3F', decimals: 2 },
	{ code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', decimals: 2 },
	{ code: 'PHP', name: 'Philippine Peso', symbol: '\u20B1', decimals: 2 },
	{ code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', decimals: 0 },
	{ code: 'ILS', name: 'Israeli Shekel', symbol: '\u20AA', decimals: 2 },
	{ code: 'AED', name: 'UAE Dirham', symbol: 'AED', decimals: 2 },
	{ code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', decimals: 2 },
	{ code: 'ISK', name: 'Icelandic Krona', symbol: 'kr', decimals: 0 },
];

const currencyMap = new Map(currencies.map((c) => [c.code, c]));

export function getCurrencySymbol(code: string): string {
	return currencyMap.get(code)?.symbol ?? code;
}

export function getCurrencyDecimals(code: string): number {
	return currencyMap.get(code)?.decimals ?? 2;
}

/** Pre-built select options for currency dropdowns (code + symbol label). */
export const currencySelectOptions = currencies.map(c => ({
	value: c.code,
	label: `${c.code} (${c.symbol})`
}));
