import { db, generateId } from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
import { clearExpiryNotifiedCache } from './monitor-notifications.js';
import { ServiceError } from '$lib/server/service-error.js';
import type { Monitor, MonitorCheck, MonitorDaily, MonitorCheckType, MonitorStatus } from '$lib/types.js';

const MAX_MONITORS = 500;

// --- Prepared statements ---

const stmtInsertMonitor = db.prepare(
	'INSERT INTO monitors (id, data, enabled, status) VALUES (?, ?, ?, ?)'
);
const stmtUpdateMonitor = db.prepare(
	"UPDATE monitors SET data = ?, enabled = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
);
const stmtDeleteMonitor = db.prepare('DELETE FROM monitors WHERE id = ?');
const stmtGetMonitor = db.prepare('SELECT id, data, enabled, status, last_checked_at, created_at, updated_at FROM monitors WHERE id = ?');
const stmtGetMonitors = db.prepare('SELECT id, data, enabled, status, last_checked_at, created_at, updated_at FROM monitors ORDER BY created_at DESC');
const stmtGetEnabledMonitors = db.prepare('SELECT id, data, enabled, status, last_checked_at, created_at, updated_at FROM monitors WHERE enabled = 1');
const stmtUpdateMonitorStatus = db.prepare(
	"UPDATE monitors SET status = ?, last_checked_at = ?, data = ?, updated_at = datetime('now') WHERE id = ?"
);

const stmtInsertCheck = db.prepare(
	'INSERT INTO monitor_checks (id, monitor_id, check_type, status, response_time_ms, message, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const stmtGetGranularChecks = db.prepare(
	'SELECT id, monitor_id, check_type, status, response_time_ms, message, checked_at FROM monitor_checks WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at DESC'
);
const stmtGetGranularChecksByType = db.prepare(
	'SELECT id, monitor_id, check_type, status, response_time_ms, message, checked_at FROM monitor_checks WHERE monitor_id = ? AND check_type = ? AND checked_at >= ? ORDER BY checked_at DESC'
);

const stmtGetDailyHistory = db.prepare(
	'SELECT monitor_id, check_type, date, uptime_percent, avg_response_ms, total_checks, failed_checks FROM monitor_daily WHERE monitor_id = ? AND date >= ? ORDER BY date DESC'
);
const stmtGetDailyHistoryByType = db.prepare(
	'SELECT monitor_id, check_type, date, uptime_percent, avg_response_ms, total_checks, failed_checks FROM monitor_daily WHERE monitor_id = ? AND check_type = ? AND date >= ? ORDER BY date DESC'
);

const stmtAggregateDay = db.prepare(`
	INSERT OR REPLACE INTO monitor_daily (monitor_id, check_type, date, uptime_percent, avg_response_ms, total_checks, failed_checks)
	SELECT monitor_id, check_type, DATE(checked_at) as date,
		ROUND(100.0 * SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) / COUNT(*), 1),
		ROUND(AVG(response_time_ms)),
		COUNT(*),
		SUM(CASE WHEN status != 'up' THEN 1 ELSE 0 END)
	FROM monitor_checks
	WHERE DATE(checked_at) = ?
	GROUP BY monitor_id, check_type
`);

const stmtPruneChecks = db.prepare("DELETE FROM monitor_checks WHERE checked_at < datetime('now', '-48 hours')");

// --- Row → Monitor ---

type MonitorRow = {
	id: string;
	data: string;
	enabled: number;
	status: string;
	last_checked_at: string | null;
	created_at: string;
	updated_at: string;
};

function rowToMonitor(row: MonitorRow): Monitor {
	const data = JSON.parse(row.data) as Record<string, unknown>;
	let ip = (data.ip as string) ?? '';
	let domain = (data.domain as string) ?? '';

	// Backward compat: migrate old target field
	if (!ip && !domain && data.target) {
		const t = data.target as string;
		if (/^(\d{1,3}\.){3}\d{1,3}$/.test(t) || /^[0-9a-fA-F:]+$/.test(t)) {
			ip = t;
		} else {
			domain = t.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
		}
	}

	return {
		id: row.id,
		name: (data.name as string) ?? '',
		ip,
		domain,
		enabled: row.enabled === 1,
		checks: (data.checks as Monitor['checks']) ?? { ping: false, http: false, domainExpiry: false, sslExpiry: false },
		httpExpectedStatus: (data.httpExpectedStatus as number) ?? 200,
		domainExpiryThresholdDays: (data.domainExpiryThresholdDays as number) ?? 30,
		sslExpiryThresholdDays: (data.sslExpiryThresholdDays as number) ?? 14,
		status: row.status as MonitorStatus,
		lastCheckedAt: row.last_checked_at,
		lastResponseTimeMs: (data.lastResponseTimeMs as number) ?? null,
		lastError: (data.lastError as string) ?? null,
		domainExpiryDate: (data.domainExpiryDate as string) ?? null,
		sslExpiryDate: (data.sslExpiryDate as string) ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function monitorToData(m: Partial<Monitor>): string {
	return JSON.stringify({
		name: m.name,
		ip: m.ip ?? '',
		domain: m.domain ?? '',
		checks: m.checks,
		httpExpectedStatus: m.httpExpectedStatus,
		domainExpiryThresholdDays: m.domainExpiryThresholdDays,
		sslExpiryThresholdDays: m.sslExpiryThresholdDays,
		lastResponseTimeMs: m.lastResponseTimeMs,
		lastError: m.lastError,
		domainExpiryDate: m.domainExpiryDate,
		sslExpiryDate: m.sslExpiryDate,
	});
}

// --- CRUD ---

export function getMonitors(): Monitor[] {
	const rows = stmtGetMonitors.all() as MonitorRow[];
	return rows.map(rowToMonitor);
}

export function getMonitor(id: string): Monitor | null {
	const row = stmtGetMonitor.get(id) as MonitorRow | undefined;
	return row ? rowToMonitor(row) : null;
}

export function getEnabledMonitors(): Monitor[] {
	const rows = stmtGetEnabledMonitors.all() as MonitorRow[];
	return rows.map(rowToMonitor);
}

const stmtCountMonitors = db.prepare('SELECT COUNT(*) as c FROM monitors');

export const createMonitor = db.transaction((data: {
	name: string;
	ip: string;
	domain: string;
	enabled: boolean;
	checks: Monitor['checks'];
	httpExpectedStatus: number;
	domainExpiryThresholdDays: number;
	sslExpiryThresholdDays: number;
}, userId: string): Monitor => {
	const { c } = stmtCountMonitors.get() as { c: number };
	if (c >= MAX_MONITORS) throw new ServiceError('error.monitorLimitReached');
	const id = generateId();
	const monitor: Partial<Monitor> = {
		...data,
		lastResponseTimeMs: null,
		lastError: null,
		domainExpiryDate: null,
		sslExpiryDate: null,
	};
	stmtInsertMonitor.run(id, monitorToData(monitor), data.enabled ? 1 : 0, 'pending');
	recordChange('monitor', id, 'create', {}, userId);
	return getMonitor(id)!;
});

export function updateMonitor(id: string, data: {
	name: string;
	ip: string;
	domain: string;
	enabled: boolean;
	checks: Monitor['checks'];
	httpExpectedStatus: number;
	domainExpiryThresholdDays: number;
	sslExpiryThresholdDays: number;
}, userId: string): Monitor | null {
	return db.transaction(() => {
		const existing = getMonitor(id);
		if (!existing) return null;
		const updated: Partial<Monitor> = {
			...data,
			lastResponseTimeMs: existing.lastResponseTimeMs,
			lastError: existing.lastError,
			domainExpiryDate: existing.domainExpiryDate,
			sslExpiryDate: existing.sslExpiryDate,
		};
		const status = data.enabled ? existing.status : 'paused';
		stmtUpdateMonitor.run(monitorToData(updated), data.enabled ? 1 : 0, status, id);
		const diff = computeDiff(
			existing as unknown as Record<string, unknown>,
			{ ...existing, ...data } as unknown as Record<string, unknown>
		);
		recordChange('monitor', id, 'update', diff, userId);
		return getMonitor(id);
	})();
}

export function deleteMonitor(id: string, userId: string): boolean {
	return db.transaction(() => {
		const existing = getMonitor(id);
		if (!existing) return false;
		stmtDeleteMonitor.run(id);
		recordChange('monitor', id, 'delete', {}, userId);
		// Clean up in-memory expiry notification cache to prevent orphaned entries
		clearExpiryNotifiedCache(id);
		return true;
	})();
}

export function toggleMonitor(id: string, enabled: boolean, userId: string): boolean {
	return db.transaction(() => {
		const existing = getMonitor(id);
		if (!existing) return false;
		const newStatus = enabled ? 'pending' : 'paused';
		const data: Partial<Monitor> = {
			name: existing.name,
			ip: existing.ip,
			domain: existing.domain,
			checks: existing.checks,
			httpExpectedStatus: existing.httpExpectedStatus,
			domainExpiryThresholdDays: existing.domainExpiryThresholdDays,
			sslExpiryThresholdDays: existing.sslExpiryThresholdDays,
			lastResponseTimeMs: existing.lastResponseTimeMs,
			lastError: existing.lastError,
			domainExpiryDate: existing.domainExpiryDate,
			sslExpiryDate: existing.sslExpiryDate,
		};
		stmtUpdateMonitor.run(monitorToData(data), enabled ? 1 : 0, newStatus, id);
		recordChange('monitor', id, 'update', { enabled: { old: existing.enabled, new: enabled } }, userId);
		return true;
	})();
}

// --- Status update (called by check orchestrator) ---

export const updateMonitorAfterCheck = db.transaction((id: string, status: MonitorStatus, data: Partial<Monitor>): void => {
	const existing = getMonitor(id);
	if (!existing) return;
	const merged: Partial<Monitor> = {
		name: existing.name,
		ip: existing.ip,
		domain: existing.domain,
		checks: existing.checks,
		httpExpectedStatus: existing.httpExpectedStatus,
		domainExpiryThresholdDays: existing.domainExpiryThresholdDays,
		sslExpiryThresholdDays: existing.sslExpiryThresholdDays,
		lastResponseTimeMs: 'lastResponseTimeMs' in data ? data.lastResponseTimeMs : existing.lastResponseTimeMs,
		lastError: 'lastError' in data ? data.lastError : existing.lastError,
		domainExpiryDate: 'domainExpiryDate' in data ? data.domainExpiryDate : existing.domainExpiryDate,
		sslExpiryDate: 'sslExpiryDate' in data ? data.sslExpiryDate : existing.sslExpiryDate,
	};
	stmtUpdateMonitorStatus.run(status, new Date().toISOString(), monitorToData(merged), id);
});

// --- Check recording ---

/** Persist expiry notification timestamp in monitor data blob (survives restarts). */
export function persistExpiryNotifiedAt(monitorId: string, type: 'domain' | 'ssl', timestamp: number): void {
	try {
		const row = stmtGetMonitor.get(monitorId) as { data: string } | undefined;
		if (!row) return;
		const data = JSON.parse(row.data);
		data[`lastExpiryNotified_${type}`] = timestamp;
		db.prepare("UPDATE monitors SET data = ? WHERE id = ?").run(JSON.stringify(data), monitorId);
	} catch { /* best effort — in-memory cache is the primary */ }
}

export function recordCheckResult(monitorId: string, checkType: MonitorCheckType, status: 'up' | 'down' | 'error', responseTimeMs: number | null, message: string): void {
	const id = generateId();
	stmtInsertCheck.run(id, monitorId, checkType, status, responseTimeMs, message, new Date().toISOString());
}

// --- History queries ---

type CheckRow = { id: string; monitor_id: string; check_type: MonitorCheckType; status: 'up' | 'down' | 'error'; response_time_ms: number | null; message: string; checked_at: string };
type DailyRow = { monitor_id: string; check_type: MonitorCheckType; date: string; uptime_percent: number; avg_response_ms: number | null; total_checks: number; failed_checks: number };

export function getGranularChecks(monitorId: string, since: string, checkType?: MonitorCheckType): MonitorCheck[] {
	const rows = checkType
		? stmtGetGranularChecksByType.all(monitorId, checkType, since) as CheckRow[]
		: stmtGetGranularChecks.all(monitorId, since) as CheckRow[];
	return rows.map(r => ({
		id: r.id,
		monitorId: r.monitor_id,
		checkType: r.check_type,
		status: r.status,
		responseTimeMs: r.response_time_ms,
		message: r.message,
		checkedAt: r.checked_at,
	}));
}

export function getDailyHistory(monitorId: string, since: string, checkType?: MonitorCheckType): MonitorDaily[] {
	const rows = checkType
		? stmtGetDailyHistoryByType.all(monitorId, checkType, since) as DailyRow[]
		: stmtGetDailyHistory.all(monitorId, since) as DailyRow[];
	return rows.map(r => ({
		monitorId: r.monitor_id,
		checkType: r.check_type,
		date: r.date,
		uptimePercent: r.uptime_percent,
		avgResponseMs: r.avg_response_ms,
		totalChecks: r.total_checks,
		failedChecks: r.failed_checks,
	}));
}

/**
 * Daily history across many monitors in one query — replaces the
 * per-monitor flatMap on the uptime listing page. IN-list against
 * idx_monitor_daily_lookup(monitor_id, date DESC); ORDER BY satisfied
 * by the index so no temp B-tree.
 */
export function getDailyHistoryForMonitors(monitorIds: string[], since: string): MonitorDaily[] {
	if (monitorIds.length === 0) return [];
	const placeholders = monitorIds.map(() => '?').join(',');
	const sql =
		`SELECT monitor_id, check_type, date, uptime_percent, avg_response_ms, total_checks, failed_checks ` +
		`FROM monitor_daily WHERE monitor_id IN (${placeholders}) AND date >= ? ` +
		`ORDER BY monitor_id, date DESC`;
	const rows = db.prepare(sql).all(...monitorIds, since) as DailyRow[];
	return rows.map(r => ({
		monitorId: r.monitor_id,
		checkType: r.check_type,
		date: r.date,
		uptimePercent: r.uptime_percent,
		avgResponseMs: r.avg_response_ms,
		totalChecks: r.total_checks,
		failedChecks: r.failed_checks,
	}));
}

// --- Aggregation + Pruning ---

const stmtUnaggregatedDates = db.prepare(`
	SELECT DISTINCT DATE(checked_at) as d FROM monitor_checks
	WHERE DATE(checked_at) < DATE('now')
	  AND DATE(checked_at) NOT IN (SELECT DISTINCT date FROM monitor_daily)
	ORDER BY d
`);

export function aggregateMonitorDaily(): void {
	// Aggregate all past dates not yet in monitor_daily (handles multi-day gaps after downtime)
	const dates = stmtUnaggregatedDates.all() as { d: string }[];
	for (const { d } of dates) {
		stmtAggregateDay.run(d);
	}
	// Always re-aggregate yesterday to capture late-arriving checks
	const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
	stmtAggregateDay.run(yesterday);
}

export function pruneOldMonitorChecks(): void {
	stmtPruneChecks.run();
}
