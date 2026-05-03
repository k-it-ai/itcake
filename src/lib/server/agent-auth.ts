import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from './db.js';
import { decryptFieldStrict } from './field-crypto.js';
import { hmacOrSha256, safeBufEqual } from './crypto-helpers.js';
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

export function hashAgentToken(token: string): string {
	return hmacOrSha256(SESSION_SECRET, token);
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
 * Refuses to sign if `agentHmacSecret` is empty: legacy pre-migration
 * agents have no shared key with the server, and the agent's
 * `VerifySignature` is fail-closed on empty secret
 * (`TestVerifySignature_EmptySecret_FailsClosed`). Surfacing the error
 * here is honest about the situation — the operator must re-enroll the
 * agent. Earlier code fell back to `SESSION_SECRET`, which produced
 * signatures the agent could never verify and obscured the diagnosis.
 */
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

// Without --pin-tls, an attacker holding a CA-trusted cert for the
// server hostname (mis-issuance / hostile CA / BGP+DV race) could
// poison the checkin reply with binaryHash=H' AND serve the matching
// binary on the immediately-following download — the agent's own
// SHA-256 check would confirm H' (an attacker-chosen value) and run
// the binary as root. This advisory carries an HMAC over the binary
// hash + the agent id + a server-issued timestamp under the per-agent
// HMAC secret, which only the legitimate server knows. The agent
// refuses self-update unless the advisory verifies.
export function signBinaryAdvisory(
	agentId: string,
	binaryHash: string,
	issuedAt: string,
	agentHmacSecret: string
): string {
	if (!agentHmacSecret) return '';
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

const stmtGetEnabledAgents = db.prepare(
	`SELECT ${AGENT_SELECT} FROM agents WHERE enabled = 1`
);

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
		if (safeBufEqual(Buffer.from(row.token_hash, 'hex'), hashedBuf)) {
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

	return {
		id: row.id,
		name: row.name,
		hostname: row.hostname,
		os: row.os,
		arch: row.arch,
		osVersion: row.os_version,
		agentVersion: row.agent_version,
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
