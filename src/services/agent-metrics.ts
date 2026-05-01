import { db, generateId, getSetting } from '$lib/server/db.js';
import type { AgentMetric, AgentMetricDaily, RmmSettings } from '$lib/types.js';


const stmtInsertMetric = db.prepare(
	'INSERT INTO agent_metrics (id, agent_id, cpu_percent, memory_used_bytes, memory_total_bytes, disk_used_bytes, disk_total_bytes, load_avg_1, load_avg_5, load_avg_15, uptime_seconds, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

const stmtGetRecentMetrics = db.prepare(
	'SELECT id, agent_id, cpu_percent, memory_used_bytes, memory_total_bytes, disk_used_bytes, disk_total_bytes, load_avg_1, load_avg_5, load_avg_15, uptime_seconds, recorded_at FROM agent_metrics WHERE agent_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC'
);

const stmtGetLatestMetric = db.prepare(
	'SELECT id, agent_id, cpu_percent, memory_used_bytes, memory_total_bytes, disk_used_bytes, disk_total_bytes, load_avg_1, load_avg_5, load_avg_15, uptime_seconds, recorded_at FROM agent_metrics WHERE agent_id = ? ORDER BY recorded_at DESC LIMIT 1'
);

const stmtGetDailyMetrics = db.prepare(
	'SELECT agent_id, date, avg_cpu, max_cpu, avg_memory_percent, max_memory_percent, avg_disk_percent, max_disk_percent, total_reports FROM agent_metrics_daily WHERE agent_id = ? AND date >= ? ORDER BY date DESC'
);

const stmtAggregateDay = db.prepare(`
	INSERT OR REPLACE INTO agent_metrics_daily (agent_id, date, avg_cpu, max_cpu, avg_memory_percent, max_memory_percent, avg_disk_percent, max_disk_percent, total_reports)
	SELECT agent_id, DATE(recorded_at) as date,
		ROUND(AVG(cpu_percent), 1),
		ROUND(MAX(cpu_percent), 1),
		ROUND(AVG(CASE WHEN memory_total_bytes > 0 THEN 100.0 * memory_used_bytes / memory_total_bytes ELSE NULL END), 1),
		ROUND(MAX(CASE WHEN memory_total_bytes > 0 THEN 100.0 * memory_used_bytes / memory_total_bytes ELSE NULL END), 1),
		ROUND(AVG(CASE WHEN disk_total_bytes > 0 THEN 100.0 * disk_used_bytes / disk_total_bytes ELSE NULL END), 1),
		ROUND(MAX(CASE WHEN disk_total_bytes > 0 THEN 100.0 * disk_used_bytes / disk_total_bytes ELSE NULL END), 1),
		COUNT(*)
	FROM agent_metrics
	WHERE DATE(recorded_at) = ?
	GROUP BY agent_id
`);

const stmtPruneMetrics = db.prepare("DELETE FROM agent_metrics WHERE recorded_at < datetime('now', ?)");

const stmtUnaggregatedDates = db.prepare(`
	SELECT DISTINCT DATE(recorded_at) as d FROM agent_metrics
	WHERE DATE(recorded_at) < DATE('now')
	  AND DATE(recorded_at) NOT IN (SELECT DISTINCT date FROM agent_metrics_daily)
	ORDER BY d
`);

type MetricRow = {
	id: string; agent_id: string; cpu_percent: number | null; memory_used_bytes: number | null;
	memory_total_bytes: number | null; disk_used_bytes: number | null; disk_total_bytes: number | null;
	load_avg_1: number | null; load_avg_5: number | null; load_avg_15: number | null;
	uptime_seconds: number | null; recorded_at: string;
};

type DailyRow = {
	agent_id: string; date: string; avg_cpu: number | null; max_cpu: number | null;
	avg_memory_percent: number | null; max_memory_percent: number | null;
	avg_disk_percent: number | null; max_disk_percent: number | null;
	total_reports: number;
};

function rowToMetric(row: MetricRow): AgentMetric {
	return {
		id: row.id,
		agentId: row.agent_id,
		cpuPercent: row.cpu_percent,
		memoryUsedBytes: row.memory_used_bytes,
		memoryTotalBytes: row.memory_total_bytes,
		diskUsedBytes: row.disk_used_bytes,
		diskTotalBytes: row.disk_total_bytes,
		loadAvg1: row.load_avg_1,
		loadAvg5: row.load_avg_5,
		loadAvg15: row.load_avg_15,
		uptimeSeconds: row.uptime_seconds,
		recordedAt: row.recorded_at
	};
}

function rowToDaily(row: DailyRow): AgentMetricDaily {
	return {
		agentId: row.agent_id,
		date: row.date,
		avgCpu: row.avg_cpu,
		maxCpu: row.max_cpu,
		avgMemoryPercent: row.avg_memory_percent,
		maxMemoryPercent: row.max_memory_percent,
		avgDiskPercent: row.avg_disk_percent,
		maxDiskPercent: row.max_disk_percent,
		totalReports: row.total_reports
	};
}


export function ingestMetrics(agentId: string, metrics: {
	cpuPercent: number | null;
	memoryUsedBytes: number | null;
	memoryTotalBytes: number | null;
	diskUsedBytes: number | null;
	diskTotalBytes: number | null;
	loadAvg1: number | null;
	loadAvg5: number | null;
	loadAvg15: number | null;
	uptimeSeconds: number | null;
}): void {
	const id = generateId();
	const recordedAt = new Date().toISOString();
	stmtInsertMetric.run(
		id, agentId,
		metrics.cpuPercent, metrics.memoryUsedBytes, metrics.memoryTotalBytes,
		metrics.diskUsedBytes, metrics.diskTotalBytes,
		metrics.loadAvg1, metrics.loadAvg5, metrics.loadAvg15,
		metrics.uptimeSeconds, recordedAt
	);
}


export function getRecentMetrics(agentId: string, since: string): AgentMetric[] {
	const rows = stmtGetRecentMetrics.all(agentId, since) as MetricRow[];
	return rows.map(rowToMetric);
}

export function getLatestMetric(agentId: string): AgentMetric | null {
	const row = stmtGetLatestMetric.get(agentId) as MetricRow | undefined;
	return row ? rowToMetric(row) : null;
}

/**
 * Latest metric per agent in a single query — replaces a per-agent SELECT
 * loop on the agents listing page. Correlated MAX(recorded_at) per agent_id
 * uses idx_agent_metrics_lookup(agent_id, recorded_at DESC) twice as a
 * covering index — one seek to bound the outer scan, one to resolve MAX.
 * Agents with no metrics are absent from the returned Map (callers fall
 * back to null).
 */
export function getLatestMetricsForAgents(agentIds: string[]): Map<string, AgentMetric> {
	const out = new Map<string, AgentMetric>();
	if (agentIds.length === 0) return out;
	const placeholders = agentIds.map(() => '?').join(',');
	const sql =
		`SELECT id, agent_id, cpu_percent, memory_used_bytes, memory_total_bytes, ` +
		`disk_used_bytes, disk_total_bytes, load_avg_1, load_avg_5, load_avg_15, ` +
		`uptime_seconds, recorded_at FROM agent_metrics m ` +
		`WHERE m.agent_id IN (${placeholders}) ` +
		`AND m.recorded_at = (SELECT MAX(m2.recorded_at) FROM agent_metrics m2 WHERE m2.agent_id = m.agent_id)`;
	const rows = db.prepare(sql).all(...agentIds) as MetricRow[];
	for (const r of rows) out.set(r.agent_id, rowToMetric(r));
	return out;
}

export function getDailyMetrics(agentId: string, since: string): AgentMetricDaily[] {
	const rows = stmtGetDailyMetrics.all(agentId, since) as DailyRow[];
	return rows.map(rowToDaily);
}


export function aggregateAgentMetricsDaily(): void {
	const dates = stmtUnaggregatedDates.all() as { d: string }[];
	for (const { d } of dates) {
		stmtAggregateDay.run(d);
	}
	// Always re-aggregate yesterday
	const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
	stmtAggregateDay.run(yesterday);
}

export function pruneOldAgentMetrics(): void {
	const settings = getSetting<RmmSettings>('rmm');
	const hours = settings?.metricsRetentionHours ?? 48;
	stmtPruneMetrics.run(`-${hours} hours`);
}
