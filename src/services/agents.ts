import { db, generateId, getSetting, incrementCounterWithMin } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { hashAgentToken, generateAgentToken, rowToAgent } from '$lib/server/agent-auth.js';
import { encryptField } from '$lib/server/field-crypto.js';
import type { Agent, RmmSettings, EnrollmentToken } from '$lib/types.js';
import crypto from 'node:crypto';

// --- Prepared statements ---

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

// --- Enrollment tokens ---

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
const stmtCleanExpiredTokens = db.prepare(
	"DELETE FROM agent_enrollment_tokens WHERE expires_at < datetime('now') AND used_at IS NULL"
);

type AgentRow = Parameters<typeof rowToAgent>[0];

// --- CRUD ---

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

/**
 * Read the raw `agents.data` JSON object — server-side only. Some fields
 * inside (e.g. `remoteDesktop`) are deliberately omitted from the
 * `Agent` type returned by getAgent() so they don't leak via UI-facing
 * API responses; callers that need them must go through this helper.
 */
export function getAgentDataRaw(id: string): Record<string, unknown> | null {
	const row = stmtGetAgentDataRaw.get(id) as { data: string } | undefined;
	if (!row) return null;
	try { return JSON.parse(row.data) as Record<string, unknown>; } catch { return {}; }
}

const stmtUpdateAgentTags = db.prepare("UPDATE agents SET tags = ?, updated_at = datetime('now') WHERE id = ?");

/**
 * Replace the agent's tag set. Tags are normalized: lowercased, stripped, and
 * filtered to a safe charset to keep them URL-friendly and shell-safe (since
 * they end up in command-targeting filters). Duplicates removed.
 */
export function setAgentTags(id: string, tags: string[], userId: string): Agent | null {
	return db.transaction(() => {
		const existing = getAgent(id);
		if (!existing) return null;
		const cleaned = Array.from(new Set(
			(tags || [])
				.map(t => String(t).toLowerCase().trim())
				.filter(t => /^[a-z0-9][a-z0-9_-]{0,49}$/.test(t))
		)).sort().slice(0, 30);
		const before = [...existing.tags].sort();
		if (JSON.stringify(before) === JSON.stringify(cleaned)) return existing;
		stmtUpdateAgentTags.run(JSON.stringify(cleaned), id);
		recordChange('agent', id, 'update', { tags: { old: before, new: cleaned } }, userId);
		return getAgent(id);
	})();
}

/** Resolve a tag filter into a set of agent IDs. */
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

// --- Enrollment ---

export function createEnrollmentToken(name: string, userId: string): { token: string; id: string; expiresAt: string } {
	const id = generateId();
	const rawToken = crypto.randomBytes(16).toString('hex');
	const tokenHash = hashAgentToken(rawToken);
	const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min TTL

	// Clean up expired tokens first
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
	/** Agent-generated per-device HMAC secret (hex). Used to sign commands
	 *  dispatched to this specific agent. Stored verbatim server-side —
	 *  NOT hashed, because HMAC needs the key on both ends. Treat as secret. */
	hmacSecret: string;
}, ip: string, userAgent = ''): { agent: Agent; bearerToken: string } => {
	const tokenHash = hashAgentToken(rawToken);
	const tokenRow = stmtGetEnrollToken.get(tokenHash) as {
		id: string; token_hash: string; name: string; expires_at: string;
	} | undefined;

	if (!tokenRow) {
		throw new Error('INVALID_TOKEN');
	}

	// Check expiry
	const expiresAt = new Date(tokenRow.expires_at.endsWith('Z') ? tokenRow.expires_at : tokenRow.expires_at + 'Z');
	if (expiresAt.getTime() < Date.now()) {
		throw new Error('TOKEN_EXPIRED');
	}

	// Reject duplicate: if an enabled agent with same hostname+os+arch already exists
	const existingAgents = getAgents();
	const duplicate = existingAgents.find(a =>
		a.enabled && a.hostname === data.hostname && a.os === data.os && a.arch === data.arch
	);
	if (duplicate) {
		// Delete the old agent to allow re-enrollment — record in audit log.
		// The old bearer AND old hmac_secret are invalidated, so any stale
		// daemon that somehow still holds them is cut off immediately.
		stmtDeleteAgent.run(duplicate.id);
		recordChange('agent', duplicate.id, 'delete', {
			reason: { old: null, new: 're-enrollment' },
			replacedBy: { old: null, new: data.hostname }
		}, 'system');
	}

	// Mark token as used (single-use)
	stmtMarkTokenUsed.run(tokenRow.id);

	// Generate agent ID and bearer token
	const agentId = generateId();
	const bearerToken = generateAgentToken();
	const bearerHash = hashAgentToken(bearerToken);

	// Validate the agent-provided HMAC secret is high-entropy hex. The Zod
	// enroll schema already requires this shape, but the service layer
	// re-checks so callers that bypass the API route (e.g. tests, future
	// admin tooling) can't smuggle a weak signing key into the DB.
	const hmacSecret = (data.hmacSecret || '').trim();
	if (!hmacSecret || !/^[0-9a-f]{32,128}$/i.test(hmacSecret)) {
		throw new Error('INVALID_HMAC_SECRET');
	}

	// Generate agent name from token name or hostname
	const counter = incrementCounterWithMin('agent_global', 1);
	const name = tokenRow.name || data.hostname || `Agent-${String(counter).padStart(3, '0')}`;

	const agentData = JSON.stringify({ ip, packageManagers: [] });

	// Encrypt hmac_secret at rest so a leaked backup or stolen DB file
	// without SESSION_SECRET cannot be used to forge commands. Decryption
	// is wrapped in agent-auth.ts::rowToAgent / agent-commands.ts.
	stmtInsertAgent.run(
		agentId, name, data.hostname, data.os, data.arch,
		data.osVersion, data.agentVersion,
		bearerHash, encryptField(hmacSecret), ip, userAgent.slice(0, 500),
		'online', agentData
	);

	recordChange('agent', agentId, 'create', {}, 'system');

	const agent = getAgent(agentId)!;
	return { agent, bearerToken };
});

// --- Check-in ---

export function processCheckin(agentId: string, data: {
	hostname?: string;
	osVersion?: string;
	agentVersion?: string;
	packageManagers?: string[];
	cpuModel?: string;
	ip?: string;
	rebootRequired?: boolean | null;
}): void {
	const existing = getAgent(agentId);
	if (!existing) {
		console.warn(`[agent] processCheckin: agent ${agentId} authenticated but not found in DB (deleted between auth and checkin?)`);
		return;
	}

	const hostname = data.hostname ?? existing.hostname;
	const osVersion = data.osVersion ?? existing.osVersion;
	const agentVersion = data.agentVersion ?? existing.agentVersion;

	// Carry over autoUpdate flags and any other data fields the UI owns;
	// re-read the raw JSON so we don't lose keys we don't know about.
	const row = stmtGetAgent.get(agentId) as { data: string } | undefined;
	let existingData: Record<string, unknown> = {};
	if (row) {
		try { existingData = JSON.parse(row.data); } catch { /* ignore corrupt */ }
	}

	const agentData: Record<string, unknown> = {
		...existingData,
		ip: data.ip ?? existing.ip,
		packageManagers: data.packageManagers ?? existing.packageManagers,
		cpuModel: data.cpuModel ?? existing.cpuModel
	};
	// rebootRequired is a current-state flag; store under a distinct key
	// so the UI can surface it without scanning time-series metrics.
	if (data.rebootRequired === true || data.rebootRequired === false) {
		agentData.rebootRequired = data.rebootRequired;
	}

	stmtUpdateAgentCheckin.run(hostname, osVersion, agentVersion, JSON.stringify(agentData), agentId);
}

// --- Stale detection ---

export function detectStaleAgents(): void {
	const settings = getSetting<RmmSettings>('rmm');
	const staleMinutes = settings?.staleThresholdMinutes ?? 5;

	// Mark online agents that haven't checked in as stale
	stmtMarkStale.run(`-${staleMinutes} minutes`);
	// Mark stale agents that haven't checked in for 3x the threshold as offline
	stmtMarkOffline.run(`-${staleMinutes * 3} minutes`);
}

export function getAgentSummary(): { total: number; online: number; offline: number; stale: number } {
	const row = db.prepare(`
		SELECT
			COUNT(*) as total,
			SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
			SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline,
			SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) as stale
		FROM agents WHERE enabled = 1
	`).get() as { total: number; online: number; offline: number; stale: number };
	return row;
}
