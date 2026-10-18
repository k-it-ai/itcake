import { db, generateId, getSetting } from '#lib/server/db.js';
import type { AgentMetric, RmmSettings } from '#lib/types.js';


const stmtInsertMetric = db.prepare(
	'INSERT INTO agent_metrics (id, agent_id, cpu_percent, memory_used_bytes, memory_total_bytes, disk_used_bytes, disk_total_bytes, load_avg_1, load_avg_5, load_avg_15, uptime_seconds, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

const stmtGetRecentMetrics = db.prepare(
	'SELECT id, agent_id, cpu_percent, memory_used_bytes, memory_total_bytes, disk_used_bytes, disk_total_bytes, load_avg_1, load_avg_5, load_avg_15, uptime_seconds, recorded_at FROM agent_metrics WHERE agent_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC'
);

const stmtGetLatestMetric = db.prepare(
	'SELECT id, agent_id, cpu_percent, memory_used_bytes, memory_total_bytes, disk_used_bytes, disk_total_bytes, load_avg_1, load_avg_5, load_avg_15, uptime_seconds, recorded_at FROM agent_metrics WHERE agent_id = ? ORDER BY recorded_at DESC LIMIT 1'
);

// recorded_at is ISO-8601; datetime() parses it before comparing.
const stmtPruneMetrics = db.prepare("DELETE FROM agent_metrics WHERE datetime(recorded_at) < datetime('now', ?)");

type MetricRow = {
	id: string; agent_id: string; cpu_percent: number | null; memory_used_bytes: number | null;
	memory_total_bytes: number | null; disk_used_bytes: number | null; disk_total_bytes: number | null;
	load_avg_1: number | null; load_avg_5: number | null; load_avg_15: number | null;
	uptime_seconds: number | null; recorded_at: string;
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

export function pruneOldAgentMetrics(): void {
	const settings = getSetting<RmmSettings>('rmm');
	// Clamp: metricsRetentionHours has no schema; a 0/negative/NaN value would interpolate
	// into datetime('now', '-N hours') and either wipe the table or silently no-op.
	const raw = Number(settings?.metricsRetentionHours);
	const hours = Number.isFinite(raw) && raw >= 1 ? Math.min(8760, Math.trunc(raw)) : 48;
	stmtPruneMetrics.run(`-${hours} hours`);
}
