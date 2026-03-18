import { getSetting, setSetting, db } from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
import { decryptField } from '$lib/server/field-crypto.js';
import type { Settings, CompanySettings } from '$lib/types.js';

const stmtGetAllSettings = db.prepare('SELECT key, value FROM settings');

export function getAllSettings(): Settings {
	const rows = stmtGetAllSettings.all() as { key: string; value: string }[];
	const map: Record<string, unknown> = {};
	for (const row of rows) {
		try {
			const parsed = JSON.parse(row.value);
			// Decrypt sensitive fields that are encrypted at rest
			if (row.key === 'emails' && parsed.smtp?.pass?.startsWith('enc:')) {
				parsed.smtp.pass = decryptField(parsed.smtp.pass);
			}
			if (row.key === 'uptime' && parsed.telegram?.botToken?.startsWith('enc:')) {
				parsed.telegram.botToken = decryptField(parsed.telegram.botToken);
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
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_MERGE_DEPTH = 5;

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>, depth = 0): Record<string, unknown> {
	if (depth > MAX_MERGE_DEPTH) {
		// At depth limit, still filter BANNED_KEYS to prevent prototype pollution
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
	'general', 'company', 'invoices', 'proposals', 'emails', 'advanced', 'uptime'
]);

export const updateSettingsSection = db.transaction((key: string, value: unknown, userId?: string): void => {
	if (!VALID_SETTINGS_KEYS.has(key)) throw new Error(`Invalid settings key: ${key}`);
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Settings value must be a plain object');
	}
	// Deep merge with existing to preserve nested fields not sent
	const existing = getSetting<Record<string, unknown>>(key);
	const merged = deepMerge(existing, value as Record<string, unknown>);
	setSetting(key, merged);

	// Audit log: record what changed (mask sensitive fields in diff)
	if (userId) {
		const diff = computeDiff(existing, merged);
		// Mask passwords/tokens — the diff captures the whole 'smtp'/'telegram' object
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
		if (Object.keys(diff).length > 0) {
			recordChange('settings', key, 'update', diff, userId);
		}
	}
});

export function isSetupComplete(): boolean {
	const company = getSetting<CompanySettings>('company');
	return !!(company.name && company.email);
}
