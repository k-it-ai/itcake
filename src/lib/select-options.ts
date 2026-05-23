import type { InvoiceStatus, ProposalStatus } from './types.js';
import { t } from './i18n/index.svelte.js';

type SelectOption = { value: string; label: string };
type StatusTone = 'neutral' | 'brand' | 'good' | 'warn' | 'bad' | 'accent';

export const interfaceLanguageOptions: SelectOption[] = [
	{ value: 'en', label: 'English' }, { value: 'de', label: 'Deutsch' },
];

const COUNTRY_CODES = [
	'NL', 'DE', 'AT', 'BE', 'BG', 'CH', 'CZ', 'DK', 'EE', 'ES', 'FI', 'FR',
	'GB', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NO', 'PL',
	'PT', 'RO', 'SE', 'SI', 'SK', 'TR', 'US', 'CA', 'AU', 'JP',
] as const;

const LANG_CODES = ['en', 'de'] as const;

export function clientLanguageOptions(): SelectOption[] {
	return LANG_CODES.map(code => ({ value: code, label: t(`lang.${code}`) }));
}

export function countrySelectOptions(): SelectOption[] {
	return [
		{ value: '', label: '' },
		...COUNTRY_CODES.map(code => ({ value: code, label: t(`country.${code}`) })),
	];
}

export const dateFormatOptions: SelectOption[] = [
	{ value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' }, { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
	{ value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' }, { value: 'DD.MM.YYYY', label: 'DD.MM.YYYY' },
];

// Single source of truth for the timezone selector — shared by the setup
// wizard and Settings → General. Adding a zone here only requires one
// edit. The default in `defaultSettings.general.timezone` is `Europe/Berlin`;
// the setup form auto-detects the browser zone and falls back to that.
export const timezoneOptions: SelectOption[] = [
	{ value: 'Europe/Amsterdam', label: 'Europe/Amsterdam' },
	{ value: 'Europe/Berlin', label: 'Europe/Berlin' },
	{ value: 'Europe/London', label: 'Europe/London' },
	{ value: 'Europe/Paris', label: 'Europe/Paris' },
	{ value: 'Europe/Zurich', label: 'Europe/Zurich' },
	{ value: 'Europe/Vienna', label: 'Europe/Vienna' },
	{ value: 'Europe/Brussels', label: 'Europe/Brussels' },
	{ value: 'Europe/Stockholm', label: 'Europe/Stockholm' },
	{ value: 'Europe/Helsinki', label: 'Europe/Helsinki' },
	{ value: 'Europe/Warsaw', label: 'Europe/Warsaw' },
	{ value: 'Europe/Budapest', label: 'Europe/Budapest' },
	{ value: 'Europe/Istanbul', label: 'Europe/Istanbul' },
	{ value: 'America/New_York', label: 'America/New York' },
	{ value: 'America/Chicago', label: 'America/Chicago' },
	{ value: 'America/Los_Angeles', label: 'America/Los Angeles' },
	{ value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
	{ value: 'Australia/Sydney', label: 'Australia/Sydney' },
	{ value: 'UTC', label: 'UTC' }
];

// v2 status tones — see assets/design/handoff-v2/06-status-system.md
const invoiceToneMap: Record<InvoiceStatus, StatusTone> = {
	draft: 'neutral',
	sent: 'brand',
	overdue: 'bad',
	paid: 'good',
	cancelled: 'neutral',
};

const proposalToneMap: Record<ProposalStatus, StatusTone> = {
	draft: 'neutral',
	sent: 'brand',
	accepted: 'good',
	rejected: 'bad',
	expired: 'bad',
};

export function invoiceStatusTone(status: string): StatusTone {
	return invoiceToneMap[status as InvoiceStatus] ?? 'neutral';
}

export function proposalStatusTone(status: string): StatusTone {
	return proposalToneMap[status as ProposalStatus] ?? 'neutral';
}

export type { StatusTone };
