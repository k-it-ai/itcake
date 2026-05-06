import { db, generateId } from '$lib/server/db.js';
import type { AgentCollectorResult, CollectorResultKind } from '$lib/types.js';

interface ResultRow {
	id: string;
	agent_id: string;
	command_id: string | null;
	kind: string;
	payload: string;
	recorded_at: string;
}

const SELECT = 'id, agent_id, command_id, kind, payload, recorded_at';

const stmtInsert = db.prepare(
	'INSERT INTO agent_collector_results (id, agent_id, command_id, kind, payload) VALUES (?, ?, ?, ?, ?)'
);
const stmtListByAgentKind = db.prepare(`SELECT ${SELECT} FROM agent_collector_results WHERE agent_id = ? AND kind = ? ORDER BY recorded_at DESC LIMIT ?`);
const stmtLatestByAgentKind = db.prepare(`SELECT ${SELECT} FROM agent_collector_results WHERE agent_id = ? AND kind = ? ORDER BY recorded_at DESC LIMIT 1`);
const stmtPruneByKind = db.prepare(
	`DELETE FROM agent_collector_results WHERE kind = ? AND recorded_at < datetime('now', ?)`
);
const stmtPruneToCount = db.prepare(
	`DELETE FROM agent_collector_results WHERE kind = ? AND id NOT IN (
		SELECT id FROM agent_collector_results WHERE kind = ? ORDER BY recorded_at DESC LIMIT ?
	)`
);

function rowToResult(r: ResultRow): AgentCollectorResult {
	let payload: Record<string, unknown> = {};
	try { payload = JSON.parse(r.payload); } catch { /* keep default */ }
	return {
		id: r.id,
		agentId: r.agent_id,
		commandId: r.command_id,
		kind: r.kind as CollectorResultKind,
		payload,
		recordedAt: r.recorded_at
	};
}

export function recordCollectorResult(input: {
	agentId: string;
	commandId: string | null;
	kind: CollectorResultKind;
	payload: Record<string, unknown>;
}): AgentCollectorResult {
	const id = generateId();
	stmtInsert.run(id, input.agentId, input.commandId, input.kind, JSON.stringify(input.payload));
	return rowToResult({
		id, agent_id: input.agentId, command_id: input.commandId,
		kind: input.kind, payload: JSON.stringify(input.payload), recorded_at: new Date().toISOString()
	});
}

export function listCollectorResults(agentId: string, kind: CollectorResultKind, limit = 50): AgentCollectorResult[] {
	const cap = Math.min(500, Math.max(1, limit));
	return (stmtListByAgentKind.all(agentId, kind, cap) as ResultRow[]).map(rowToResult);
}

export function getLatestCollectorResult(agentId: string, kind: CollectorResultKind): AgentCollectorResult | null {
	const row = stmtLatestByAgentKind.get(agentId, kind) as ResultRow | undefined;
	return row ? rowToResult(row) : null;
}

/**
 * Per-kind retention. Reliability dailies are tiny and we keep 90d (one
 * row per agent per day → ~9 KB max). Filesystem analyses are large
 * (10s of KB) so 30d. Network discovery snapshots can be huge — keep
 * the most recent N per agent (default 20) instead of by age.
 */
export function pruneOldCollectorResults(): { kind: CollectorResultKind; deleted: number }[] {
	const rules: Array<{ kind: CollectorResultKind; mode: 'age' | 'count'; arg: string | number }> = [
		{ kind: 'reliability_daily', mode: 'age', arg: '-90 days' },
		{ kind: 'filesystem_analysis', mode: 'age', arg: '-60 days' },
		{ kind: 'network_baseline', mode: 'count', arg: 20 },
		{ kind: 'network_discovery', mode: 'count', arg: 20 },
		{ kind: 'peripheral_inventory', mode: 'count', arg: 30 }
	];
	const out: { kind: CollectorResultKind; deleted: number }[] = [];
	for (const r of rules) {
		const result = r.mode === 'age'
			? stmtPruneByKind.run(r.kind, r.arg as string)
			: stmtPruneToCount.run(r.kind, r.kind, r.arg as number);
		out.push({ kind: r.kind, deleted: result.changes });
	}
	return out;
}
