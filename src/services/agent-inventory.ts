import { db } from '#lib/server/db.js';
import { ingestEvents } from '#services/agent-events.js';
import type { AgentService, AgentPackage } from '#lib/types.js';


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

const stmtSelectPackageSnapshot = db.prepare(
	'SELECT name, version FROM agent_packages WHERE agent_id = ? AND manager = ?'
);

export function upsertPackages(agentId: string, packages: Array<{
	manager: string; name: string; version: string; latestVersion: string; updateAvailable: boolean;
}>): void {
	const byManager = new Map<string, typeof packages>();
	for (const pkg of packages) {
		const list = byManager.get(pkg.manager) || [];
		list.push(pkg);
		byManager.set(pkg.manager, list);
	}

	type Change = { kind: 'installed' | 'removed' | 'upgraded'; manager: string; name: string; from?: string; to?: string };
	const changes: Change[] = [];

	const upsertTx = db.transaction(() => {
		for (const [manager, pkgs] of byManager) {
			const existingRows = stmtSelectPackageSnapshot.all(agentId, manager) as { name: string; version: string }[];
			const existing = new Map(existingRows.map(r => [r.name, r.version]));
			const incoming = new Map(pkgs.map(p => [p.name, p.version]));

			for (const [name, version] of incoming) {
				const was = existing.get(name);
				if (was === undefined) {
					changes.push({ kind: 'installed', manager, name, to: version });
				} else if (was !== version) {
					changes.push({ kind: 'upgraded', manager, name, from: was, to: version });
				}
			}
			for (const [name, version] of existing) {
				if (!incoming.has(name)) {
					changes.push({ kind: 'removed', manager, name, from: version });
				}
			}

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

	if (changes.length > 0) {
		const installCountByMgr = new Map<string, number>();
		const installCountInChanges = new Map<string, number>();
		for (const [mgr, pkgs] of byManager) installCountByMgr.set(mgr, pkgs.length);
		for (const c of changes) {
			if (c.kind === 'installed') installCountInChanges.set(c.manager, (installCountInChanges.get(c.manager) ?? 0) + 1);
		}
		const firstSnapshot = new Set<string>();
		for (const [mgr, n] of installCountInChanges) {
			if (n === installCountByMgr.get(mgr) && n > 5) firstSnapshot.add(mgr);
		}

		const events = changes
			.filter(c => !firstSnapshot.has(c.manager))
			.slice(0, 200)
			.map(c => ({
				level: 'warning' as const,
				source: `package_change:${c.manager}`,
				message: c.kind === 'installed'
					? `installed ${c.name}${c.to ? ` ${c.to}` : ''}`
					: c.kind === 'removed'
						? `removed ${c.name}${c.from ? ` ${c.from}` : ''}`
						: `upgraded ${c.name} ${c.from} → ${c.to}`,
				occurredAt: new Date().toISOString()
			}));
		if (events.length > 0) ingestEvents(agentId, events);
	}
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
