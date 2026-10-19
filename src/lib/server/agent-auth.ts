import crypto from 'node:crypto';
import { NODE_ENV, SESSION_SECRET as SESSION_SECRET_ENV } from '$app/env/private';
import { db, getSetting, setSetting } from './db.js';
import { decryptFieldStrict } from './field-crypto.js';
import { hmacOrSha256 } from './crypto-helpers.js';
import type { Agent } from '#lib/types.js';

const stmtGetAgentHmac = db.prepare('SELECT hmac_secret FROM agents WHERE id = ?');
export function getAgentHmacSecret(agentId: string): string {
	const row = stmtGetAgentHmac.get(agentId) as { hmac_secret: string | null } | undefined;
	if (!row?.hmac_secret) return '';
	return decryptFieldStrict(row.hmac_secret, `agent.hmacSecret:${agentId}`);
}

const SESSION_SECRET = SESSION_SECRET_ENV || '';
if (!SESSION_SECRET) {
	if (NODE_ENV !== 'development') {
		throw new Error(
			'SESSION_SECRET is required in production for agent token security. ' +
			'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
		);
	}
} else if (SESSION_SECRET.length < 32) {
	throw new Error('SESSION_SECRET must be at least 32 characters for agent token security.');
}

let cachedAgentTokenPepper: string | null = null;

/**
 * Agent token hashes use a per-install pepper (settings.agentTokenPepper),
 * not SESSION_SECRET — rotation must not lock out every agent, and their
 * plaintext tokens can never be re-hashed server-side.
 */
export function getAgentTokenPepper(): string {
	if (cachedAgentTokenPepper) return cachedAgentTokenPepper;
	const stored = getSetting<string>('agentTokenPepper');
	if (typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored)) {
		cachedAgentTokenPepper = stored;
	} else {
		cachedAgentTokenPepper = crypto.randomBytes(32).toString('hex');
		setSetting('agentTokenPepper', cachedAgentTokenPepper);
	}
	return cachedAgentTokenPepper;
}

/** Drop the memoised pepper after a backup restore rewrites settings. */
export function clearAgentTokenPepperCache(): void {
	cachedAgentTokenPepper = null;
}

export function hashAgentToken(token: string): string {
	return hmacOrSha256(getAgentTokenPepper(), token);
}

export function generateAgentToken(): string {
	return crypto.randomBytes(32).toString('hex');
}

// `payload` must be verbatim DB bytes — re-marshalling breaks agent-side HMAC verify.
export class LegacyEnrollmentError extends Error {
	constructor(agentId: string) {
		super(`agent ${agentId} predates per-agent HMAC enrollment; re-enroll required before commands can be issued`);
		this.name = 'LegacyEnrollmentError';
	}
}

export function signCommand(
	commandId: string,
	agentId: string,
	type: string,
	payload: string,
	timestamp: string,
	agentHmacSecret: string
): string {
	if (!agentHmacSecret) throw new LegacyEnrollmentError(agentId);
	const message = `${commandId}:${agentId}:${type}:${payload}:${timestamp}`;
	return crypto.createHmac('sha256', agentHmacSecret).update(message).digest('hex');
}

export function signBinaryAdvisory(
	agentId: string,
	binaryHash: string,
	issuedAt: string,
	agentHmacSecret: string
): string {
	if (!agentHmacSecret) throw new LegacyEnrollmentError(agentId);
	const message = `binary-advisory:${agentId}:${binaryHash}:${issuedAt}`;
	return crypto.createHmac('sha256', agentHmacSecret).update(message).digest('hex');
}

type AgentRow = {
	id: string;
	name: string;
	hostname: string;
	os: string;
	arch: string;
	os_version: string;
	agent_version: string;
	token_hash: string;
	hmac_secret?: string;
	monitor_id: string | null;
	status: string;
	enabled: number;
	last_seen_at: string | null;
	tags?: string;
	data: string;
	created_at: string;
	updated_at: string;
};

const AGENT_SELECT = 'id, name, hostname, os, arch, os_version, agent_version, token_hash, hmac_secret, monitor_id, status, enabled, last_seen_at, tags, data, created_at, updated_at';

const stmtGetAgentByTokenHash = db.prepare(
	`SELECT ${AGENT_SELECT} FROM agents WHERE token_hash = ? AND enabled = 1`
);

export function authenticateAgent(request: Request): Agent | null {
	const authHeader = request.headers.get('authorization');
	if (!authHeader) return null;

	const match = authHeader.match(/^Bearer\s+([0-9a-f]{64})$/i);
	if (!match) return null;

	const rawToken = match[1];
	const tokenHash = hashAgentToken(rawToken);

	const matched = stmtGetAgentByTokenHash.get(tokenHash) as AgentRow | undefined;
	if (!matched) return null;
	return rowToAgent(matched);
}

export function rowToAgent(row: AgentRow): Agent {
	let data: Record<string, unknown> = {};
	try { data = JSON.parse(row.data); } catch (e) { console.error(`[agent-auth] Corrupted JSON in agent ${row.id} data column:`, e instanceof Error ? e.message : e); }
	let tags: string[] = [];
	try { if (row.tags) tags = JSON.parse(row.tags); } catch { tags = []; }
	if (!Array.isArray(tags)) tags = [];

	// hmacSecret intentionally omitted — decrypted-only via getAgentHmacSecret to avoid JSON-serialisation leak.
	return {
		id: row.id,
		name: row.name,
		hostname: row.hostname,
		os: row.os,
		arch: row.arch,
		osVersion: row.os_version,
		agentVersion: row.agent_version,
		monitorId: row.monitor_id,
		status: row.status as Agent['status'],
		enabled: row.enabled === 1,
		lastSeenAt: row.last_seen_at,
		tags,
		ip: (data.ip as string) ?? '',
		packageManagers: (data.packageManagers as string[]) ?? [],
		cpuModel: (data.cpuModel as string) ?? '',
		autoUpdateSoftware: (data.autoUpdateSoftware as boolean) ?? false,
		autoUpdateOS: (data.autoUpdateOS as boolean) ?? false,
		autoUpdateIntervalHours: (data.autoUpdateIntervalHours as number) ?? 24,
		rebootRequired: (data.rebootRequired as boolean | undefined) ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}
