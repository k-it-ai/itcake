import { getSetting, setSetting, db } from '#lib/server/db.js';
import { recordChange, computeDiff } from '#lib/server/changes.js';
import { BACKUP_VALID_SETTINGS_KEYS } from '#lib/server/backup-allowlists.js';
import type { Settings, CompanySettings, BackupSettings } from '#lib/types.js';

export const SETTINGS_MASK = '••••••••';

const stmtGetAllSettings = db.prepare('SELECT key FROM settings');

export function getAllSettings(): Settings {
	const rows = stmtGetAllSettings.all() as { key: string }[];
	const map: Record<string, unknown> = {};
	for (const row of rows) {
		try {
			const parsed = structuredClone(getSetting<Record<string, unknown>>(row.key));
			if (row.key === 'emails') {
				const smtp = parsed.smtp as { pass?: string } | undefined;
				if (smtp?.pass) smtp.pass = SETTINGS_MASK;
			}
			if (row.key === 'uptime') {
				const tg = parsed.telegram as { botToken?: string } | undefined;
				if (tg?.botToken) tg.botToken = SETTINGS_MASK;
			}
			if (row.key === 'backup') {
				const b = parsed as { encryptionPassphrase?: string };
				if (b.encryptionPassphrase) b.encryptionPassphrase = SETTINGS_MASK;
			}
			if (row.key === 'ai') {
				const a = parsed as { apiKey?: string };
				if (a.apiKey) a.apiKey = SETTINGS_MASK;
			}
			if (row.key === 'rmm') {
				const r = parsed as { updateManifestPrivateKey?: string };
				if (r.updateManifestPrivateKey) r.updateManifestPrivateKey = SETTINGS_MASK;
			}
			if (row.key === 'telemetry') {
				const t = parsed as { errorReportingDsn?: string };
				if (t.errorReportingDsn) t.errorReportingDsn = SETTINGS_MASK;
			}
			map[row.key] = parsed;
		} catch (e) {
			console.error(`Failed to load setting "${row.key}":`, e instanceof Error ? e.message : e);
		}
	}
	return map as unknown as Settings;
}

// Union restricted to credential-free sections — getSettingsSection bypasses masking.
export type CredentialFreeSettingsSection =
	| 'general'
	| 'company'
	| 'invoices'
	| 'proposals'
	| 'advanced';

export function getSettingsSection<T>(key: CredentialFreeSettingsSection): T {
	return getSetting<T>(key);
}

const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const MAX_MERGE_DEPTH = 5;

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>, depth = 0): Record<string, unknown> {
	if (depth > MAX_MERGE_DEPTH) {
		const result = { ...target };
		for (const [k, v] of Object.entries(source)) {
			if (!BANNED_KEYS.has(k)) result[k] = v;
		}
		return result;
	}
	const result = { ...target };
	for (const [k, v] of Object.entries(source)) {
		if (BANNED_KEYS.has(k)) continue;
		if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
			result[k] = deepMerge(target[k] as Record<string, unknown>, v as Record<string, unknown>, depth + 1);
		} else {
			result[k] = v;
		}
	}
	return result;
}

const VALID_SETTINGS_KEYS = BACKUP_VALID_SETTINGS_KEYS;

export const updateSettingsSection = db.transaction((key: string, value: unknown, userId?: string): void => {
	if (!VALID_SETTINGS_KEYS.has(key)) throw new Error(`Invalid settings key: ${key}`);
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Settings value must be a plain object');
	}
	const existing = getSetting<Record<string, unknown>>(key);
	const merged = deepMerge(existing, value as Record<string, unknown>);

	if (key === 'backup') {
		const m = merged as unknown as BackupSettings & Record<string, unknown>;
		const prev = existing as unknown as BackupSettings | undefined;
		const passOK = (v: unknown): v is string => typeof v === 'string';

		if (passOK(m.encryptionPassphrase) && m.encryptionPassphrase === SETTINGS_MASK) {
			m.encryptionPassphrase = prev?.encryptionPassphrase ?? '';
		}
	}
	if (key === 'rmm') {
		const m = merged as Record<string, unknown>;
		if (m.updateManifestPrivateKey === SETTINGS_MASK) {
			const prev = existing as Record<string, unknown>;
			m.updateManifestPrivateKey = (prev.updateManifestPrivateKey as string) ?? '';
		}
	}
	if (key === 'telemetry') {
		const m = merged as Record<string, unknown>;
		if (m.errorReportingDsn === SETTINGS_MASK) {
			const prev = existing as Record<string, unknown>;
			m.errorReportingDsn = (prev.errorReportingDsn as string) ?? '';
		}
	}

	setSetting(key, merged);

	if (userId) {
		const diff = computeDiff(existing, merged);
		if (key === 'emails' && diff.smtp) {
			const maskSmtp = (obj: unknown) => {
				if (obj && typeof obj === 'object' && 'pass' in obj) return { ...obj, pass: SETTINGS_MASK };
				return obj;
			};
			diff.smtp = { old: maskSmtp(diff.smtp.old), new: maskSmtp(diff.smtp.new) };
		}
		if (key === 'uptime' && diff.telegram) {
			const maskTg = (obj: unknown) => {
				if (obj && typeof obj === 'object' && 'botToken' in obj) return { ...obj, botToken: SETTINGS_MASK };
				return obj;
			};
			diff.telegram = { old: maskTg(diff.telegram.old), new: maskTg(diff.telegram.new) };
		}
		if (key === 'ai' && 'apiKey' in diff) {
			diff.apiKey = { old: SETTINGS_MASK, new: SETTINGS_MASK };
		}
		if (key === 'rmm' && 'updateManifestPrivateKey' in diff) {
			diff.updateManifestPrivateKey = { old: SETTINGS_MASK, new: SETTINGS_MASK };
		}
		if (key === 'telemetry' && 'errorReportingDsn' in diff) {
			diff.errorReportingDsn = { old: SETTINGS_MASK, new: SETTINGS_MASK };
		}
		if (key === 'backup') {
			if ('encryptionPassphrase' in diff) {
				diff.encryptionPassphrase = { old: SETTINGS_MASK, new: SETTINGS_MASK };
			}
		}
		if (Object.keys(diff).length > 0) {
			recordChange('settings', key, 'update', diff, userId);
		}
	}
});

export function isSetupComplete(): boolean {
	const company = getSetting<CompanySettings>('company');
	return !!(company.name && company.email);
}
