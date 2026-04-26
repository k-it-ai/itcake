import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from './db.js';
import { decryptFieldStrict } from './field-crypto.js';
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
 * Hash a bearer token for storage/lookup using HMAC-SHA256. Server-side only;
 * the plaintext token never hits the DB.
 */
export function hashAgentToken(token: string): string {
	if (SESSION_SECRET) {
		return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
	}
	return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateAgentToken(): string {
	return crypto.randomBytes(32).toString('hex');
}

/**
 * Sign a command with the per-agent HMAC secret established during
 * enrollment. Signature covers `commandId:agentId:type:payload:timestamp`
 * — the agent re-computes this and rejects anything that doesn't match.
 *
 * `payload` MUST be the exact string the agent will receive (JSON.stringify
 * of the command payload object). Any discrepancy — whitespace,
 * key order, unescaped characters — will fail verification on the agent.
 *
 * Falls back to SESSION_SECRET for legacy (pre-migration) agents that
 * enrolled before per-agent secrets existed. Those agents will keep
 * working until re-enrolled, at which point they get their own secret.
 */
export function signCommand(
	commandId: string,
	agentId: string,
	type: string,
	payload: string,
	timestamp: string,
	agentHmacSecret: string
): string {
	const message = `${commandId}:${agentId}:${type}:${payload}:${timestamp}`;
	const key = agentHmacSecret || SESSION_SECRET;
	if (!key) {
		throw new Error('Cannot sign command: neither per-agent secret nor SESSION_SECRET available');
	}
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

const stmtGetEnabledAgents = db.prepare(
	`SELECT ${AGENT_SELECT} FROM agents WHERE enabled = 1`
);

/**
 * Extract and verify a bearer token from the Authorization header using
 * constant-time comparison across all enabled agents.
 *
 * Returns the full row (including hmac_secret) so callers can both
 * authenticate the check-in AND sign outgoing commands with the same
 * fetched row — avoids a second DB round-trip.
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
	let tags: string[] = [];
	try { if (row.tags) tags = JSON.parse(row.tags); } catch { tags = []; }
	if (!Array.isArray(tags)) tags = [];

	// hmac_secret is only populated when the SELECT includes it (agent-auth
	// path, server-side signing). UI-facing SELECTs in services/agents.ts omit
	// the column so it never leaves the server. The on-disk value is
	// AES-GCM encrypted (enc2:); we decrypt here so callers receive the
	// HMAC key in usable form. Falls through plaintext for legacy rows
	// pre-migration and for dev mode without SESSION_SECRET.
	return {
		id: row.id,
		name: row.name,
		hostname: row.hostname,
		os: row.os,
		arch: row.arch,
		osVersion: row.os_version,
		agentVersion: row.agent_version,
		// `decryptFieldStrict` refuses to read a value that isn't enc-prefixed
		// when SESSION_SECRET is set — defends against a DB writer who
		// replaces this column with chosen plaintext to forge command
		// signatures. Pass the per-agent AAD so v3 ciphertexts bound to
		// THIS row's id decrypt correctly; row-shuffled v3 values fail
		// GCM tag check.
		hmacSecret: row.hmac_secret ? decryptFieldStrict(row.hmac_secret, `agent.hmacSecret:${row.id}`) : row.hmac_secret,
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
