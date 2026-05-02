import { db, generateId, getSetting, incrementCounterWithMin, parseSqliteUtc } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { hashAgentToken, generateAgentToken, rowToAgent } from '$lib/server/agent-auth.js';
import { encryptField } from '$lib/server/field-crypto.js';
import { TAG_REGEX, MAX_TAGS_PER_AGENT } from '$lib/validators-rmm.js';
import type { Agent, RmmSettings, EnrollmentToken } from '$lib/types.js';
import crypto from 'node:crypto';


const stmtInsertAgent = db.prepare(
	'INSERT INTO agents (id, name, hostname, os, arch, os_version, agent_version, token_hash, hmac_secret, enrolled_ip, enrolled_user_agent, status, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const stmtGetAgent = db.prepare(
	'SELECT id, name, hostname, os, arch, os_version, agent_version, token_hash, monitor_id, status, enabled, last_seen_at, tags, data, created_at, updated_at FROM agents WHERE id = ?'
);
const stmtGetAgents = db.prepare(
	'SELECT id, name, hostname, os, arch, os_version, agent_version, token_hash, monitor_id, status, enabled, last_seen_at, tags, data, created_at, updated_at FROM agents ORDER BY created_at DESC'
);
const stmtUpdateAgent = db.prepare(
	"UPDATE agents SET name = ?, enabled = ?, monitor_id = ?, updated_at = datetime('now') WHERE id = ?"
);
const stmtDeleteAgent = db.prepare('DELETE FROM agents WHERE id = ?');
const stmtUpdateAgentCheckin = db.prepare(
	"UPDATE agents SET hostname = ?, os_version = ?, agent_version = ?, status = 'online', last_seen_at = datetime('now'), data = ?, updated_at = datetime('now') WHERE id = ?"
);
const stmtMarkStale = db.prepare(
	"UPDATE agents SET status = 'stale', updated_at = datetime('now') WHERE enabled = 1 AND status = 'online' AND last_seen_at < datetime('now', ?)"
);
const stmtMarkOffline = db.prepare(
	"UPDATE agents SET status = 'offline', updated_at = datetime('now') WHERE enabled = 1 AND status = 'stale' AND last_seen_at < datetime('now', ?)"
);
const stmtFindEnabledAgentByHostnameOsArch = db.prepare(
	'SELECT id FROM agents WHERE enabled = 1 AND hostname = ? AND os = ? AND arch = ? LIMIT 1'
);


const stmtInsertEnrollToken = db.prepare(
	'INSERT INTO agent_enrollment_tokens (id, token_hash, name, expires_at) VALUES (?, ?, ?, ?)'
);
const stmtGetEnrollToken = db.prepare(
	'SELECT id, token_hash, name, expires_at, used_at, created_at FROM agent_enrollment_tokens WHERE token_hash = ? AND used_at IS NULL'
);
const stmtMarkTokenUsed = db.prepare(
	"UPDATE agent_enrollment_tokens SET used_at = datetime('now') WHERE id = ?"
);
const stmtGetEnrollTokens = db.prepare(
	'SELECT id, token_hash, name, expires_at, used_at, created_at FROM agent_enrollment_tokens ORDER BY created_at DESC LIMIT 50'
);
// datetime(col) normalises ISO column vs `datetime('now')` space format.
const stmtCleanExpiredTokens = db.prepare(
	"DELETE FROM agent_enrollment_tokens WHERE datetime(expires_at) < datetime('now') AND used_at IS NULL"
);

type AgentRow = Parameters<typeof rowToAgent>[0];


export function getAgents(): Agent[] {
	const rows = stmtGetAgents.all() as AgentRow[];
	return rows.map(rowToAgent);
}

export function getAgent(id: string): Agent | null {
	const row = stmtGetAgent.get(id) as AgentRow | undefined;
	return row ? rowToAgent(row) : null;
}

export function updateAgent(id: string, data: { name?: string; enabled?: boolean; monitorId?: string | null }, userId: string): Agent | null {
	return db.transaction(() => {
		const existing = getAgent(id);
		if (!existing) return null;

		const name = data.name ?? existing.name;
		const enabled = data.enabled ?? existing.enabled;
		const monitorId = data.monitorId !== undefined ? data.monitorId : existing.monitorId;

		stmtUpdateAgent.run(name, enabled ? 1 : 0, monitorId, id);

		const diff: Record<string, { old: unknown; new: unknown }> = {};
		if (name !== existing.name) diff.name = { old: existing.name, new: name };
		if (enabled !== existing.enabled) diff.enabled = { old: existing.enabled, new: enabled };
		if (monitorId !== existing.monitorId) diff.monitorId = { old: existing.monitorId, new: monitorId };
		if (Object.keys(diff).length > 0) {
			recordChange('agent', id, 'update', diff, userId);
		}

		return getAgent(id);
	})();
}

const stmtUpdateAgentData = db.prepare('UPDATE agents SET data = ?, updated_at = datetime(?) WHERE id = ?');

export function updateAgentAutoUpdate(id: string, settings: {
	autoUpdateSoftware?: boolean;
	autoUpdateOS?: boolean;
	autoUpdateIntervalHours?: number;
}, userId: string): Agent | null {
	return db.transaction(() => {
		const existing = getAgent(id);
		if (!existing) return null;

		const row = stmtGetAgent.get(id) as { data: string } | undefined;
		if (!row) return null;

		let data: Record<string, unknown> = {};
		try { data = JSON.parse(row.data); } catch { /* empty */ }

		const diff: Record<string, { old: unknown; new: unknown }> = {};
		if (settings.autoUpdateSoftware !== undefined && data.autoUpdateSoftware !== settings.autoUpdateSoftware) {
			diff.autoUpdateSoftware = { old: data.autoUpdateSoftware ?? false, new: settings.autoUpdateSoftware };
			data.autoUpdateSoftware = settings.autoUpdateSoftware;
		}
		if (settings.autoUpdateOS !== undefined && data.autoUpdateOS !== settings.autoUpdateOS) {
			diff.autoUpdateOS = { old: data.autoUpdateOS ?? false, new: settings.autoUpdateOS };
			data.autoUpdateOS = settings.autoUpdateOS;
		}
		if (settings.autoUpdateIntervalHours !== undefined && data.autoUpdateIntervalHours !== settings.autoUpdateIntervalHours) {
			diff.autoUpdateIntervalHours = { old: data.autoUpdateIntervalHours ?? 24, new: settings.autoUpdateIntervalHours };
			data.autoUpdateIntervalHours = settings.autoUpdateIntervalHours;
		}

		if (Object.keys(diff).length > 0) {
			stmtUpdateAgentData.run(JSON.stringify(data), new Date().toISOString(), id);
			recordChange('agent', id, 'update', diff, userId);
		}

		return getAgent(id);
	})();
}

const stmtGetAgentDataRaw = db.prepare('SELECT data FROM agents WHERE id = ?');

// Server-only: returns the full data blob. The `Agent` type from
// getAgent() deliberately omits fields like `remoteDesktop` so they
// don't leak via UI-facing API responses.
export function getAgentDataRaw(id: string): Record<string, unknown> | null {
	const row = stmtGetAgentDataRaw.get(id) as { data: string } | undefined;
	if (!row) return null;
	try { return JSON.parse(row.data) as Record<string, unknown>; } catch { return {}; }
}

const stmtUpdateAgentTags = db.prepare("UPDATE agents SET tags = ?, updated_at = datetime('now') WHERE id = ?");

export function setAgentTags(id: string, tags: string[], userId: string): Agent | null {
	return db.transaction(() => {
		const existing = getAgent(id);
		if (!existing) return null;
		const cleaned = Array.from(new Set(
			(tags || [])
				.map(t => String(t).toLowerCase().trim())
				.filter(t => TAG_REGEX.test(t))
		)).sort().slice(0, MAX_TAGS_PER_AGENT);
		const before = [...existing.tags].sort();
		if (JSON.stringify(before) === JSON.stringify(cleaned)) return existing;
		stmtUpdateAgentTags.run(JSON.stringify(cleaned), id);
		recordChange('agent', id, 'update', { tags: { old: before, new: cleaned } }, userId);
		return getAgent(id);
	})();
}

export function getAgentsByTags(opts: { any?: string[]; all?: string[] }): Agent[] {
	const all = getAgents();
	const anyTags = (opts.any || []).map(t => t.toLowerCase());
	const allTags = (opts.all || []).map(t => t.toLowerCase());
	return all.filter(a => {
		if (!a.enabled) return false;
		if (anyTags.length && !anyTags.some(t => a.tags.includes(t))) return false;
		if (allTags.length && !allTags.every(t => a.tags.includes(t))) return false;
		return true;
	});
}

export function deleteAgent(id: string, userId: string): boolean {
	return db.transaction(() => {
		const existing = getAgent(id);
		if (!existing) return false;
		stmtDeleteAgent.run(id);
		recordChange('agent', id, 'delete', {}, userId);
		return true;
	})();
}


export function createEnrollmentToken(name: string): { token: string; id: string; expiresAt: string } {
	const id = generateId();
	const rawToken = crypto.randomBytes(16).toString('hex');
	const tokenHash = hashAgentToken(rawToken);
	const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

	stmtCleanExpiredTokens.run();

	stmtInsertEnrollToken.run(id, tokenHash, name, expiresAt);
	return { token: rawToken, id, expiresAt };
}

export function getEnrollmentTokens(): EnrollmentToken[] {
	const rows = stmtGetEnrollTokens.all() as {
		id: string; token_hash: string; name: string; expires_at: string; used_at: string | null; created_at: string;
	}[];
	return rows.map(r => ({
		id: r.id,
		name: r.name,
		expiresAt: r.expires_at,
		usedAt: r.used_at,
		createdAt: r.created_at
	}));
}

export const enrollAgent = db.transaction((rawToken: string, data: {
	hostname: string;
	os: string;
	arch: string;
	osVersion: string;
	agentVersion: string;
	/** Per-device hex HMAC secret. Stored verbatim (not hashed — HMAC needs the key both ends). */
	hmacSecret: string;
}, ip: string, userAgent = ''): { agent: Agent; bearerToken: string } => {
	const tokenHash = hashAgentToken(rawToken);
	const tokenRow = stmtGetEnrollToken.get(tokenHash) as {
		id: string; token_hash: string; name: string; expires_at: string;
	} | undefined;

	if (!tokenRow) {
		throw new Error('INVALID_TOKEN');
	}

	if (parseSqliteUtc(tokenRow.expires_at) < Date.now()) {
		throw new Error('TOKEN_EXPIRED');
	}

	// Reject duplicates rather than cascade-delete: hostname is agent-
	// controlled, so silent replace would let a fresh enrollment token
	// impersonate `gw-prod-01` and wipe its audit trail. Re-enrollment
	// must go through an explicit UI delete first.
	if (data.hostname !== '') {
		const dup = stmtFindEnabledAgentByHostnameOsArch.get(data.hostname, data.os, data.arch) as { id: string } | undefined;
		if (dup) {
			throw new Error('HOSTNAME_ALREADY_ENROLLED');
		}
	}

	stmtMarkTokenUsed.run(tokenRow.id);

	const agentId = generateId();
	const bearerToken = generateAgentToken();
	const bearerHash = hashAgentToken(bearerToken);

	// Re-validate hmacSecret shape so service-layer callers (tests,
	// future tooling) can't bypass the route Zod and smuggle a weak key.
	// Lower bound matches the Go agent's 32-byte crypto/rand output.
	const hmacSecret = (data.hmacSecret || '').trim();
	if (!hmacSecret || !/^[0-9a-f]{64,128}$/i.test(hmacSecret)) {
		throw new Error('INVALID_HMAC_SECRET');
	}

	const counter = incrementCounterWithMin('agent_global', 1);
	const name = tokenRow.name || data.hostname || `Agent-${String(counter).padStart(3, '0')}`;

	const agentData = JSON.stringify({ ip, packageManagers: [] });

	// AAD `agent.hmacSecret:<agentId>` binds the ciphertext to this
	// row — a DB writer copying it across rows hits GCM tag failure.
	stmtInsertAgent.run(
		agentId, name, data.hostname, data.os, data.arch,
		data.osVersion, data.agentVersion,
		bearerHash, encryptField(hmacSecret, `agent.hmacSecret:${agentId}`), ip, userAgent.slice(0, 500),
		'online', agentData
	);

	recordChange('agent', agentId, 'create', {}, 'system');

	const agent = getAgent(agentId)!;
	return { agent, bearerToken };
});


export function processCheckin(agentId: string, data: {
	hostname?: string;
	osVersion?: string;
	agentVersion?: string;
	packageManagers?: string[];
	cpuModel?: string;
	ip?: string;
	rebootRequired?: boolean | null;
}): void {
	const row = stmtGetAgent.get(agentId) as AgentRow | undefined;
	if (!row) {
		console.warn(`[agent] processCheckin: agent ${agentId} authenticated but not found in DB (deleted between auth and checkin?)`);
		return;
	}
	const existing = rowToAgent(row);

	const hostname = data.hostname ?? existing.hostname;
	const osVersion = data.osVersion ?? existing.osVersion;
	const agentVersion = data.agentVersion ?? existing.agentVersion;

	// Use raw JSON, not rowToAgent's projection, so UI-owned keys
	// (e.g. remoteDesktop) survive the round-trip.
	let existingData: Record<string, unknown> = {};
	try { existingData = JSON.parse(row.data); } catch { /* ignore corrupt */ }

	const agentData: Record<string, unknown> = {
		...existingData,
		ip: data.ip ?? existing.ip,
		packageManagers: data.packageManagers ?? existing.packageManagers,
		cpuModel: data.cpuModel ?? existing.cpuModel
	};
	if (data.rebootRequired === true || data.rebootRequired === false) {
		agentData.rebootRequired = data.rebootRequired;
	}

	stmtUpdateAgentCheckin.run(hostname, osVersion, agentVersion, JSON.stringify(agentData), agentId);
}


export function detectStaleAgents(): void {
	const settings = getSetting<RmmSettings>('rmm');
	const staleMinutes = settings?.staleThresholdMinutes ?? 5;
	stmtMarkStale.run(`-${staleMinutes} minutes`);
	stmtMarkOffline.run(`-${staleMinutes * 3} minutes`);
}

const stmtAgentSummary = db.prepare(`
	SELECT
		COUNT(*) as total,
		SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
		SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline,
		SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) as stale
	FROM agents WHERE enabled = 1
`);

export function getAgentSummary(): { total: number; online: number; offline: number; stale: number } {
	return stmtAgentSummary.get() as { total: number; online: number; offline: number; stale: number };
}
