import { db, parseSqliteUtc } from '$lib/server/db.js';
import { dispatchCommand } from './agent-commands.js';

export type AutoUpdateAgent = {
	id: string;
	status: 'online' | 'offline' | 'stale' | 'pending';
	enabled: boolean;
	autoUpdateSoftware: boolean;
	autoUpdateOS: boolean;
	autoUpdateIntervalHours: number;
	lastAutoUpdateAt: string | null;
};

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
		try { d = JSON.parse(r.data); } catch { /* corrupt → no auto-update */ }
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
