import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from './db.js';
import type { Agent } from '$lib/types.js';

const SESSION_SECRET = env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
	if (env.NODE_ENV !== 'development') {
		throw new Error(
			'SESSION_SECRET is required in production for agent token security. ' +
			'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
		);
	}
} else if (SESSION_SECRET.length < 32) {
	throw new Error('SESSION_SECRET must be at least 32 characters for agent token security.');
}

/**
 * Hash a bearer token for storage/lookup using HMAC-SHA256.
 * Same key derivation as session tokens in auth.ts.
 */
export function hashAgentToken(token: string): string {
	if (SESSION_SECRET) {
		return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
	}
	return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a cryptographically random bearer token.
 */
export function generateAgentToken(): string {
	return crypto.randomBytes(32).toString('hex');
}

/**
 * Sign a command for agent verification using HMAC-SHA256.
 * Signature covers: commandId:agentId:type:body:timestamp
 */
export function signCommand(commandId: string, agentId: string, type: string, payload: string, timestamp: string): string {
	const message = `${commandId}:${agentId}:${type}:${payload}:${timestamp}`;
	const key = SESSION_SECRET || 'dev-only-key';
	return crypto.createHmac('sha256', key).update(message).digest('hex');
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
	monitor_id: string | null;
	status: string;
	enabled: number;
	last_seen_at: string | null;
	data: string;
	created_at: string;
	updated_at: string;
};

const stmtGetEnabledAgents = db.prepare(
	'SELECT id, name, hostname, os, arch, os_version, agent_version, token_hash, monitor_id, status, enabled, last_seen_at, data, created_at, updated_at FROM agents WHERE enabled = 1'
);

/**
 * Extract and verify a bearer token from the Authorization header.
 * Uses constant-time comparison to prevent timing attacks on token hashes,
 * matching the session token pattern in auth.ts.
 */
export function authenticateAgent(request: Request): Agent | null {
	const authHeader = request.headers.get('authorization');
	if (!authHeader) return null;

	const match = authHeader.match(/^Bearer\s+([0-9a-f]{64})$/i);
	if (!match) return null;

	const rawToken = match[1];
	const tokenHash = hashAgentToken(rawToken);
	const hashedBuf = Buffer.from(tokenHash, 'hex');

	const rows = stmtGetEnabledAgents.all() as AgentRow[];
	let matched: AgentRow | null = null;
	for (const row of rows) {
		const storedBuf = Buffer.from(row.token_hash, 'hex');
		if (storedBuf.length === hashedBuf.length && crypto.timingSafeEqual(storedBuf, hashedBuf)) {
			matched = row;
		}
	}

	if (!matched) return null;
	return rowToAgent(matched);
}

export function rowToAgent(row: AgentRow): Agent {
	let data: Record<string, unknown> = {};
	try { data = JSON.parse(row.data); } catch (e) { console.error(`[agent-auth] Corrupted JSON in agent ${row.id} data column:`, e instanceof Error ? e.message : e); }

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
		ip: (data.ip as string) ?? '',
		packageManagers: (data.packageManagers as string[]) ?? [],
		cpuModel: (data.cpuModel as string) ?? '',
		autoUpdateSoftware: (data.autoUpdateSoftware as boolean) ?? false,
		autoUpdateOS: (data.autoUpdateOS as boolean) ?? false,
		autoUpdateIntervalHours: (data.autoUpdateIntervalHours as number) ?? 24,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}
