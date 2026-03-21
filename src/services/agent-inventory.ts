import { db } from '$lib/server/db.js';
import type { AgentService, AgentPackage } from '$lib/types.js';

// --- Services ---

const stmtUpsertService = db.prepare(`
	INSERT INTO agent_services (agent_id, name, status, enabled, data, updated_at)
	VALUES (?, ?, ?, ?, ?, datetime('now'))
	ON CONFLICT(agent_id, name) DO UPDATE SET
		status = excluded.status,
		enabled = excluded.enabled,
		data = excluded.data,
		updated_at = datetime('now')
`);

const stmtGetServices = db.prepare(
	'SELECT agent_id, name, status, enabled, data, updated_at FROM agent_services WHERE agent_id = ? ORDER BY name ASC'
);

const stmtDeleteServices = db.prepare('DELETE FROM agent_services WHERE agent_id = ?');

export function upsertServices(agentId: string, services: Array<{
	name: string; status: string; enabled: boolean | null; data: Record<string, unknown>;
}>): void {
	const upsertTx = db.transaction(() => {
		// Clear stale entries before reinserting
		stmtDeleteServices.run(agentId);
		for (const svc of services) {
			stmtUpsertService.run(
				agentId, svc.name, svc.status,
				svc.enabled === null ? null : svc.enabled ? 1 : 0,
				JSON.stringify(svc.data)
			);
		}
	});
	upsertTx();
}

export function getServices(agentId: string): AgentService[] {
	const rows = stmtGetServices.all(agentId) as {
		agent_id: string; name: string; status: string; enabled: number | null;
		data: string; updated_at: string;
	}[];
	return rows.map(r => ({
		agentId: r.agent_id,
		name: r.name,
		status: r.status,
		enabled: r.enabled === null ? null : r.enabled === 1,
		data: JSON.parse(r.data),
		updatedAt: r.updated_at
	}));
}

// --- Packages ---

const stmtUpsertPackage = db.prepare(`
	INSERT INTO agent_packages (agent_id, manager, name, version, latest_version, update_available, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
	ON CONFLICT(agent_id, manager, name) DO UPDATE SET
		version = excluded.version,
		latest_version = excluded.latest_version,
		update_available = excluded.update_available,
		updated_at = datetime('now')
`);

const stmtGetPackages = db.prepare(
	'SELECT agent_id, manager, name, version, latest_version, update_available, updated_at FROM agent_packages WHERE agent_id = ? ORDER BY manager ASC, name ASC'
);

const stmtGetUpdatablePackages = db.prepare(
	'SELECT agent_id, manager, name, version, latest_version, update_available, updated_at FROM agent_packages WHERE agent_id = ? AND update_available = 1 ORDER BY manager ASC, name ASC'
);

const stmtDeletePackages = db.prepare('DELETE FROM agent_packages WHERE agent_id = ? AND manager = ?');

export function upsertPackages(agentId: string, packages: Array<{
	manager: string; name: string; version: string; latestVersion: string; updateAvailable: boolean;
}>): void {
	// Group by manager to clear stale entries per manager
	const byManager = new Map<string, typeof packages>();
	for (const pkg of packages) {
		const list = byManager.get(pkg.manager) || [];
		list.push(pkg);
		byManager.set(pkg.manager, list);
	}

	const upsertTx = db.transaction(() => {
		for (const [manager, pkgs] of byManager) {
			stmtDeletePackages.run(agentId, manager);
			for (const pkg of pkgs) {
				stmtUpsertPackage.run(
					agentId, pkg.manager, pkg.name,
					pkg.version, pkg.latestVersion,
					pkg.updateAvailable ? 1 : 0
				);
			}
		}
	});
	upsertTx();
}

export function getPackages(agentId: string): AgentPackage[] {
	const rows = stmtGetPackages.all(agentId) as {
		agent_id: string; manager: string; name: string; version: string;
		latest_version: string; update_available: number; updated_at: string;
	}[];
	return rows.map(r => ({
		agentId: r.agent_id,
		manager: r.manager,
		name: r.name,
		version: r.version,
		latestVersion: r.latest_version,
		updateAvailable: r.update_available === 1,
		updatedAt: r.updated_at
	}));
}

export function getUpdatablePackages(agentId: string): AgentPackage[] {
	const rows = stmtGetUpdatablePackages.all(agentId) as {
		agent_id: string; manager: string; name: string; version: string;
		latest_version: string; update_available: number; updated_at: string;
	}[];
	return rows.map(r => ({
		agentId: r.agent_id,
		manager: r.manager,
		name: r.name,
		version: r.version,
		latestVersion: r.latest_version,
		updateAvailable: r.update_available === 1,
		updatedAt: r.updated_at
	}));
}
