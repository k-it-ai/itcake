import { getSetting, setSetting, db } from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
import { encryptField, isEncryptedField } from '$lib/server/field-crypto.js';
import type { Settings, CompanySettings, BackupSettings } from '$lib/types.js';

const stmtGetAllSettings = db.prepare('SELECT key, value FROM settings');

export function getAllSettings(): Settings {
	const rows = stmtGetAllSettings.all() as { key: string; value: string }[];
	const map: Record<string, unknown> = {};
	for (const row of rows) {
		try {
			const parsed = JSON.parse(row.value);
			if (row.key === 'emails' && parsed.smtp?.pass) {
				parsed.smtp.pass = '***';
			}
			if (row.key === 'uptime' && parsed.telegram?.botToken) {
				parsed.telegram.botToken = '***';
			}
			if (row.key === 'backup') {
				if (parsed.encryptionPassphrase) parsed.encryptionPassphrase = '***';
				if (parsed.offsite?.s3?.secretAccessKey) parsed.offsite.s3.secretAccessKey = '***';
				if (parsed.offsite?.webdav?.password) parsed.offsite.webdav.password = '***';
			}
			map[row.key] = parsed;
		} catch (e) {
			console.error(`Corrupted JSON in setting "${row.key}":`, e instanceof Error ? e.message : e);
		}
	}
	return map as unknown as Settings;
}

export function getSettingsSection<T>(key: string): T {
	return getSetting<T>(key);
}

/** Keys that must never be merged — prevents prototype pollution via JSON payloads. */
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

const VALID_SETTINGS_KEYS = new Set([
	'general', 'company', 'invoices', 'proposals', 'emails', 'advanced', 'uptime', 'rmm', 'backup', 'remoteDesktop'
]);

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

		if (passOK(m.encryptionPassphrase)) {
			if (m.encryptionPassphrase === '***') {
				m.encryptionPassphrase = prev?.encryptionPassphrase ?? '';
			} else if (m.encryptionPassphrase && !isEncryptedField(m.encryptionPassphrase)) {
				m.encryptionPassphrase = encryptField(m.encryptionPassphrase);
			}
		}
		const s3 = m.offsite?.s3 as { secretAccessKey?: string } | undefined;
		if (s3 && passOK(s3.secretAccessKey)) {
			if (s3.secretAccessKey === '***') {
				s3.secretAccessKey = prev?.offsite?.s3?.secretAccessKey ?? '';
			} else if (s3.secretAccessKey && !isEncryptedField(s3.secretAccessKey)) {
				s3.secretAccessKey = encryptField(s3.secretAccessKey);
			}
		}
		const wd = m.offsite?.webdav as { password?: string } | undefined;
		if (wd && passOK(wd.password)) {
			if (wd.password === '***') {
				wd.password = prev?.offsite?.webdav?.password ?? '';
			} else if (wd.password && !isEncryptedField(wd.password)) {
				wd.password = encryptField(wd.password);
			}
		}
	}

	setSetting(key, merged);

	if (userId) {
		const diff = computeDiff(existing, merged);
		if (key === 'emails' && diff.smtp) {
			const maskSmtp = (obj: unknown) => {
				if (obj && typeof obj === 'object' && 'pass' in obj) return { ...obj, pass: '***' };
				return obj;
			};
			diff.smtp = { old: maskSmtp(diff.smtp.old), new: maskSmtp(diff.smtp.new) };
		}
		if (key === 'uptime' && diff.telegram) {
			const maskTg = (obj: unknown) => {
				if (obj && typeof obj === 'object' && 'botToken' in obj) return { ...obj, botToken: '***' };
				return obj;
			};
			diff.telegram = { old: maskTg(diff.telegram.old), new: maskTg(diff.telegram.new) };
		}
		if (key === 'backup') {
			if ('encryptionPassphrase' in diff) {
				diff.encryptionPassphrase = { old: '***', new: '***' };
			}
			if (diff.offsite) {
				const maskOffsite = (obj: unknown) => {
					if (!obj || typeof obj !== 'object') return obj;
					const o = obj as Record<string, unknown>;
					const s3 = o.s3 as Record<string, unknown> | undefined;
					const wd = o.webdav as Record<string, unknown> | undefined;
					return {
						...o,
						...(s3 ? { s3: { ...s3, ...(s3.secretAccessKey ? { secretAccessKey: '***' } : {}) } } : {}),
						...(wd ? { webdav: { ...wd, ...(wd.password ? { password: '***' } : {}) } } : {})
					};
				};
				diff.offsite = { old: maskOffsite(diff.offsite.old), new: maskOffsite(diff.offsite.new) };
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
