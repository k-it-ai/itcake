import type { InvoiceStatus, ProposalStatus } from './types.js';
import { t } from './i18n/index.svelte.js';

type SelectOption = { value: string; label: string };
type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';
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

const invoiceBadgeMap: Record<InvoiceStatus, BadgeVariant> = {
	draft: 'default',
	sent: 'info',
	paid: 'success',
	overdue: 'danger',
	cancelled: 'warning',
};

const proposalBadgeMap: Record<ProposalStatus, BadgeVariant> = {
	draft: 'default',
	sent: 'info',
	accepted: 'success',
	rejected: 'danger',
	expired: 'warning',
};

export function invoiceBadgeVariant(status: string): BadgeVariant {
	return invoiceBadgeMap[status as InvoiceStatus] ?? 'default';
}

export function proposalBadgeVariant(status: string): BadgeVariant {
	return proposalBadgeMap[status as ProposalStatus] ?? 'default';
}

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
