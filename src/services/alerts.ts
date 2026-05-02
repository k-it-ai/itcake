import { db, generateId, getSetting, parseSqliteUtc } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { ServiceError } from '$lib/server/service-error.js';
import { sendEmail } from '$services/emails.js';
import { sendTelegramMessage } from '$services/monitor-notifications.js';
import { escapeHtml, sanitizeHeader } from '$lib/server/sanitize.js';
import { serverT } from '$lib/i18n/server.js';
import { alertScopeFor } from '$lib/validators-rmm.js';
import type { AlertRule, AlertCondition, GeneralSettings, UptimeSettings } from '$lib/types.js';

interface AlertRuleRow {
	id: string;
	name: string;
	enabled: number;
	scope: string;
	condition: string;
	cooldown_minutes: number;
	channels: string;
	last_fired_at: string | null;
	user_id: string;
	created_at: string;
	updated_at: string;
}

const SELECT = 'id, name, enabled, scope, condition, cooldown_minutes, channels, last_fired_at, user_id, created_at, updated_at';

const stmtInsert = db.prepare(
	`INSERT INTO alert_rules (id, name, enabled, scope, condition, cooldown_minutes, channels, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtList = db.prepare(`SELECT ${SELECT} FROM alert_rules ORDER BY created_at DESC`);
const stmtListEnabled = db.prepare(`SELECT ${SELECT} FROM alert_rules WHERE enabled = 1`);
const stmtGet = db.prepare(`SELECT ${SELECT} FROM alert_rules WHERE id = ?`);
const stmtUpdate = db.prepare(
	`UPDATE alert_rules SET name = ?, enabled = ?, scope = ?, condition = ?, cooldown_minutes = ?, channels = ?, updated_at = datetime('now') WHERE id = ?`
);
const stmtDelete = db.prepare('DELETE FROM alert_rules WHERE id = ?');
const stmtMarkFired = db.prepare("UPDATE alert_rules SET last_fired_at = datetime('now') WHERE id = ?");

function rowToRule(r: AlertRuleRow): AlertRule {
	let condition: AlertCondition;
	try {
		condition = JSON.parse(r.condition);
	} catch {
		throw new Error(`alert_rules.condition is not valid JSON for rule ${r.id}`);
	}
	let channels: ('telegram' | 'email')[] = ['telegram', 'email'];
	try {
		const parsed = JSON.parse(r.channels);
		if (Array.isArray(parsed)) channels = parsed.filter((c): c is 'telegram' | 'email' => c === 'telegram' || c === 'email');
	} catch { /* fall back to default */ }
	return {
		id: r.id,
		name: r.name,
		enabled: r.enabled === 1,
		scope: r.scope as AlertRule['scope'],
		condition,
		cooldownMinutes: r.cooldown_minutes,
		channels,
		lastFiredAt: r.last_fired_at,
		userId: r.user_id,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

export function listAlertRules(): AlertRule[] {
	return (stmtList.all() as AlertRuleRow[]).map(rowToRule);
}

export function getAlertRule(id: string): AlertRule | null {
	const row = stmtGet.get(id) as AlertRuleRow | undefined;
	return row ? rowToRule(row) : null;
}

export function createAlertRule(input: {
	name: string;
	enabled?: boolean;
	condition: AlertCondition;
	cooldownMinutes?: number;
	channels?: ('telegram' | 'email')[];
}, userId: string): AlertRule {
	if (!input.name.trim()) throw new ServiceError('error.alertNameRequired');
	const id = generateId();
	const scope = alertScopeFor(input.condition.kind);
	stmtInsert.run(
		id,
		input.name.slice(0, 200),
		input.enabled === false ? 0 : 1,
		scope,
		JSON.stringify(input.condition),
		input.cooldownMinutes ?? 60,
		JSON.stringify(input.channels ?? ['telegram', 'email']),
		userId
	);
	recordChange('alert_rule', id, 'create', { name: { old: null, new: input.name } }, userId);
	return getAlertRule(id)!;
}

export function updateAlertRule(id: string, input: {
	name?: string;
	enabled?: boolean;
	condition?: AlertCondition;
	cooldownMinutes?: number;
	channels?: ('telegram' | 'email')[];
}, userId: string): AlertRule | null {
	const existing = getAlertRule(id);
	if (!existing) return null;
	const name = input.name ?? existing.name;
	if (!name.trim()) throw new ServiceError('error.alertNameRequired');
	const enabled = input.enabled ?? existing.enabled;
	const condition = input.condition ?? existing.condition;
	const scope = alertScopeFor(condition.kind);
	const cooldownMinutes = input.cooldownMinutes ?? existing.cooldownMinutes;
	const channels = input.channels ?? existing.channels;
	stmtUpdate.run(name.slice(0, 200), enabled ? 1 : 0, scope, JSON.stringify(condition), cooldownMinutes, JSON.stringify(channels), id);
	recordChange('alert_rule', id, 'update', { name: { old: existing.name, new: name }, enabled: { old: existing.enabled, new: enabled } }, userId);
	return getAlertRule(id);
}

export function deleteAlertRule(id: string, userId: string): boolean {
	const existing = getAlertRule(id);
	if (!existing) return false;
	stmtDelete.run(id);
	recordChange('alert_rule', id, 'delete', { name: { old: existing.name, new: null } }, userId);
	return true;
}


function getT() {
	const lang = getSetting<GeneralSettings>('general')?.language || 'en';
	return serverT(lang);
}

function isCooldownExpired(rule: AlertRule, now: Date): boolean {
	if (!rule.lastFiredAt) return true;
	const last = parseSqliteUtc(rule.lastFiredAt);
	if (Number.isNaN(last)) return true;
	return now.getTime() - last >= rule.cooldownMinutes * 60_000;
}

interface AlertHit {
	subject: string;
	bodyText: string;
	bodyHtml: string;
}

function buildHit(headline: string, lines: string[]): AlertHit {
	return {
		subject: headline,
		bodyText: [headline, ...lines].join('\n'),
		bodyHtml: [`<b>${escapeHtml(headline)}</b>`, ...lines.map(l => escapeHtml(l))].join('\n')
	};
}

function passesTagAny(rowTagsJson: string, tagAny: string[] | undefined): boolean {
	if (!tagAny || tagAny.length === 0) return true;
	let parsed: unknown = [];
	try { parsed = JSON.parse(rowTagsJson); } catch { /* untagged */ }
	const tags = Array.isArray(parsed) ? parsed as string[] : [];
	return tagAny.some(t => tags.includes(t));
}

function evaluateMetricThreshold(cond: Extract<AlertCondition, { kind: 'metric_threshold' }>): AlertHit | null {
	let metricExpr: string;
	switch (cond.metric) {
		case 'cpu':
			metricExpr = 'cpu_percent';
			break;
		case 'memory':
			metricExpr = '(CASE WHEN memory_total_bytes > 0 THEN (memory_used_bytes * 100.0 / memory_total_bytes) ELSE NULL END)';
			break;
		case 'disk':
			metricExpr = '(CASE WHEN disk_total_bytes > 0 THEN (disk_used_bytes * 100.0 / disk_total_bytes) ELSE NULL END)';
			break;
		default:
			throw new Error(`Invalid alert metric: ${cond.metric}`);
	}

	const windowMin = Math.max(1, cond.durationMinutes ?? 0);
	const sinceClause = cond.durationMinutes && cond.durationMinutes > 0
		? `AND datetime(recorded_at) >= datetime('now', ?)`
		: '';
	const ALLOWED_OPS = new Set(['>', '>=', '<', '<=', '=', '!=']);
	if (!ALLOWED_OPS.has(cond.op)) {
		throw new Error(`Invalid alert operator: ${cond.op}`);
	}
	const op = cond.op;
	const sql = `
		SELECT a.id, a.name, a.tags, AVG(${metricExpr}) AS avg_val, MAX(${metricExpr}) AS max_val
		FROM agents a
		JOIN agent_metrics m ON m.agent_id = a.id
		WHERE a.enabled = 1
		  ${sinceClause}
		GROUP BY a.id
		HAVING avg_val IS NOT NULL AND avg_val ${op} ?`;
	const args: unknown[] = [];
	if (cond.durationMinutes && cond.durationMinutes > 0) args.push(`-${windowMin} minutes`);
	args.push(cond.value);
	const rows = db.prepare(sql).all(...args) as { id: string; name: string; tags: string; avg_val: number; max_val: number }[];
	const hits = rows.filter(r => passesTagAny(r.tags, cond.tagAny));
	if (hits.length === 0) return null;
	const t = getT();
	const headline = t('alert.metricBreached', {
		metric: cond.metric, op: cond.op, value: cond.value, count: hits.length
	});
	const lines = hits.slice(0, 20).map(h => `• ${h.name}: ${h.avg_val.toFixed(1)}% (peak ${h.max_val.toFixed(1)}%)`);
	return buildHit(headline, lines);
}

function evaluateAgentOffline(cond: Extract<AlertCondition, { kind: 'agent_offline' }>): AlertHit | null {
	const rows = db.prepare(`
		SELECT id, name, tags, last_seen_at FROM agents
		WHERE enabled = 1 AND status = 'offline'
		  AND (last_seen_at IS NULL OR last_seen_at < datetime('now', ?))
	`).all(`-${cond.durationMinutes} minutes`) as { id: string; name: string; tags: string; last_seen_at: string | null }[];
	const hits = rows.filter(r => passesTagAny(r.tags, cond.tagAny));
	if (hits.length === 0) return null;
	const t = getT();
	const headline = t('alert.agentsOffline', { count: hits.length, minutes: cond.durationMinutes });
	const lines = hits.slice(0, 20).map(h => `• ${h.name}${h.last_seen_at ? ` (${h.last_seen_at})` : ''}`);
	return buildHit(headline, lines);
}

function evaluateRebootRequired(cond: Extract<AlertCondition, { kind: 'agent_reboot_required' }>): AlertHit | null {
	const rows = db.prepare(`
		SELECT id, name, tags FROM agents
		WHERE enabled = 1 AND json_extract(data, '$.rebootRequired') = 1
	`).all() as { id: string; name: string; tags: string }[];
	const hits = rows.filter(r => passesTagAny(r.tags, cond.tagAny));
	if (hits.length === 0) return null;
	const t = getT();
	const headline = t('alert.rebootRequired', { count: hits.length });
	const lines = hits.slice(0, 20).map(h => `• ${h.name}`);
	return buildHit(headline, lines);
}

function evaluateMonitorStatus(cond: Extract<AlertCondition, { kind: 'monitor_status' }>): AlertHit | null {
	const filterIds = cond.monitorIds && cond.monitorIds.length > 0;
	const placeholders = filterIds ? cond.monitorIds!.map(() => '?').join(',') : '';
	const sql = `
		SELECT id, name FROM monitors
		WHERE enabled = 1 AND status = ?
		  ${filterIds ? `AND id IN (${placeholders})` : ''}
	`;
	const args: unknown[] = [cond.status];
	if (filterIds) args.push(...cond.monitorIds!);
	const rows = db.prepare(sql).all(...args) as { id: string; name: string }[];
	if (rows.length === 0) return null;
	const t = getT();
	const headline = t('alert.monitorsDown', { status: cond.status, count: rows.length });
	const lines = rows.slice(0, 20).map(r => `• ${r.name}`);
	return buildHit(headline, lines);
}

function evaluateRule(rule: AlertRule): AlertHit | null {
	switch (rule.condition.kind) {
		case 'metric_threshold': return evaluateMetricThreshold(rule.condition);
		case 'agent_offline': return evaluateAgentOffline(rule.condition);
		case 'agent_reboot_required': return evaluateRebootRequired(rule.condition);
		case 'monitor_status': return evaluateMonitorStatus(rule.condition);
	}
}

async function dispatchAlert(rule: AlertRule, hit: AlertHit): Promise<void> {
	const settings = getSetting<UptimeSettings>('uptime');
	if (!settings) return;
	const subject = sanitizeHeader(`[${rule.name}] ${hit.subject}`);

	if (rule.channels.includes('telegram') && settings.telegram?.enabled && settings.telegram.botToken && settings.telegram.chatId) {
		try {
			await sendTelegramMessage(settings.telegram.botToken, settings.telegram.chatId, `\u{1F514} <b>${escapeHtml(rule.name)}</b>\n${hit.bodyHtml}`);
		} catch (e) {
			console.error(`[alerts] Telegram dispatch failed for rule ${rule.id}:`, e instanceof Error ? e.message : e);
		}
	}

	if (rule.channels.includes('email') && settings.emailAlerts && settings.alertEmail) {
		try {
			await sendEmail({ to: settings.alertEmail, subject, body: hit.bodyText });
		} catch (e) {
			console.error(`[alerts] Email dispatch failed for rule ${rule.id}:`, e instanceof Error ? e.message : e);
		}
	}
}

export function evaluateAlertRules(now: Date = new Date()): number {
	const rows = stmtListEnabled.all() as AlertRuleRow[];
	let fired = 0;
	for (const r of rows) {
		let rule: AlertRule;
		try { rule = rowToRule(r); }
		catch (e) { console.error(`[alerts] skipping malformed rule ${r.id}:`, e instanceof Error ? e.message : e); continue; }
		if (!isCooldownExpired(rule, now)) continue;
		let hit: AlertHit | null = null;
		try { hit = evaluateRule(rule); }
		catch (e) { console.error(`[alerts] evaluation failed for rule ${rule.id}:`, e instanceof Error ? e.message : e); continue; }
		if (!hit) continue;
		stmtMarkFired.run(rule.id);
		fired++;
		dispatchAlert(rule, hit).catch(e => console.error(`[alerts] dispatch failed for rule ${rule.id}:`, e));
	}
	return fired;
}
