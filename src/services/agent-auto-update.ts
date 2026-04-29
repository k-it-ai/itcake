import { db, parseSqliteUtc } from '$lib/server/db.js';
import { dispatchCommand } from './agent-commands.js';

/** Input shape for the pure scheduling decision — no DB access, easy to unit-test. */
export type AutoUpdateAgent = {
	id: string;
	status: 'online' | 'offline' | 'stale' | 'pending';
	enabled: boolean;
	autoUpdateSoftware: boolean;
	autoUpdateOS: boolean;
	autoUpdateIntervalHours: number;
	lastAutoUpdateAt: string | null;
};

/**
 * Pure scheduler decision. Returns the list of (agentId, commandType) that
 * should be dispatched right now. Separated from the DB layer so the logic
 * is deterministically testable.
 *
 * An agent is due for auto-update when:
 *   - it is enabled,
 *   - it is NOT offline (stale is still worth trying — it may be coming back),
 *   - at least one of autoUpdateSoftware / autoUpdateOS is on,
 *   - `intervalHours` have elapsed since `lastAutoUpdateAt` (NULL means never dispatched → due immediately).
 */
export function computeAutoUpdateDispatch(
	agents: AutoUpdateAgent[],
	now: number = Date.now()
): Array<{ agentId: string; type: 'software_update' | 'os_update' }> {
	const out: Array<{ agentId: string; type: 'software_update' | 'os_update' }> = [];
	for (const a of agents) {
		if (!a.enabled) continue;
		if (a.status === 'offline') continue;
		if (!a.autoUpdateSoftware && !a.autoUpdateOS) continue;

		const intervalHours = a.autoUpdateIntervalHours > 0 ? a.autoUpdateIntervalHours : 24;
		const intervalMs = intervalHours * 60 * 60 * 1000;

		const lastMs = a.lastAutoUpdateAt ? parseSqliteUtc(a.lastAutoUpdateAt) : 0;
		if (now - lastMs < intervalMs) continue;

		if (a.autoUpdateSoftware) out.push({ agentId: a.id, type: 'software_update' });
		if (a.autoUpdateOS) out.push({ agentId: a.id, type: 'os_update' });
	}
	return out;
}

const stmtGetCandidates = db.prepare(
	`SELECT id, status, enabled, data, last_auto_update_at
	 FROM agents
	 WHERE enabled = 1 AND status != 'offline'`
);
const stmtMarkDispatched = db.prepare(
	"UPDATE agents SET last_auto_update_at = datetime('now') WHERE id = ?"
);

/**
 * Production wrapper. Queries the DB for eligible agents, runs the pure decision
 * function, dispatches each command through the signing pipeline, and records
 * the dispatch timestamp so the interval is respected next tick.
 *
 * Returns the number of DISTINCT agents for which at least one command was
 * dispatched (useful in tests + logs).
 */
export function processAutoUpdates(now: number = Date.now()): number {
	const rows = stmtGetCandidates.all() as Array<{
		id: string;
		status: 'online' | 'offline' | 'stale' | 'pending';
		enabled: number;
		data: string;
		last_auto_update_at: string | null;
	}>;

	const input: AutoUpdateAgent[] = rows.map(r => {
		let d: Record<string, unknown> = {};
		try { d = JSON.parse(r.data); } catch { /* treat corrupt JSON as no auto-update */ }
		return {
			id: r.id,
			status: r.status,
			enabled: r.enabled === 1,
			autoUpdateSoftware: d.autoUpdateSoftware === true,
			autoUpdateOS: d.autoUpdateOS === true,
			autoUpdateIntervalHours: typeof d.autoUpdateIntervalHours === 'number' ? d.autoUpdateIntervalHours : 24,
			lastAutoUpdateAt: r.last_auto_update_at
		};
	});

	const decisions = computeAutoUpdateDispatch(input, now);
	const dispatchedAgents = new Set<string>();
	for (const d of decisions) {
		try {
			const timeout = d.type === 'os_update' ? 1800 : 600;
			dispatchCommand(d.agentId, d.type, {}, 'system', timeout);
			dispatchedAgents.add(d.agentId);
		} catch (e) {
			console.error(`[auto-update] ${d.type} dispatch failed for ${d.agentId}:`, e instanceof Error ? e.message : e);
		}
	}
	for (const id of dispatchedAgents) {
		stmtMarkDispatched.run(id);
	}
	return dispatchedAgents.size;
}
