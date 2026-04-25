import { db, generateId, getSetting } from '$lib/server/db.js';
import { signCommand } from '$lib/server/agent-auth.js';
import { recordChange } from '$lib/server/changes.js';
import type { AgentCommand, AgentCommandType, RmmSettings } from '$lib/types.js';

// --- Prepared statements ---

const stmtInsertCommand = db.prepare(
	'INSERT INTO agent_commands (id, agent_id, type, payload, signature, status, issued_at, timeout_seconds, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const stmtGetPendingCommands = db.prepare(
	"SELECT id, agent_id, type, payload, signature, status, issued_at, started_at, completed_at, exit_code, stdout, stderr, timeout_seconds, user_id, created_at FROM agent_commands WHERE agent_id = ? AND status = 'pending' ORDER BY created_at ASC"
);
const stmtGetCommand = db.prepare(
	'SELECT id, agent_id, type, payload, signature, status, issued_at, started_at, completed_at, exit_code, stdout, stderr, timeout_seconds, user_id, created_at FROM agent_commands WHERE id = ?'
);
const stmtGetCommandHistory = db.prepare(
	'SELECT id, agent_id, type, payload, signature, status, issued_at, started_at, completed_at, exit_code, stdout, stderr, timeout_seconds, user_id, created_at FROM agent_commands WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
);
const stmtUpdateCommandResult = db.prepare(
	"UPDATE agent_commands SET status = ?, exit_code = ?, stdout = ?, stderr = ?, started_at = ?, completed_at = ?, created_at = created_at WHERE id = ? AND agent_id = ?"
);
const stmtExpireCommands = db.prepare(
	"UPDATE agent_commands SET status = 'expired' WHERE status = 'pending' AND issued_at < datetime('now', ?)"
);
const stmtGetAgentHmac = db.prepare('SELECT hmac_secret FROM agents WHERE id = ?');

type CommandRow = {
	id: string; agent_id: string; type: string; payload: string; signature: string;
	status: string; issued_at: string; started_at: string | null; completed_at: string | null;
	exit_code: number | null; stdout: string; stderr: string; timeout_seconds: number;
	user_id: string; created_at: string;
};

function rowToCommand(row: CommandRow): AgentCommand {
	let payload: Record<string, unknown> = {};
	try { payload = JSON.parse(row.payload); } catch (e) { console.error(`[agent-commands] Corrupted payload JSON in command ${row.id}:`, e instanceof Error ? e.message : e); }
	return {
		id: row.id,
		agentId: row.agent_id,
		type: row.type as AgentCommandType,
		payload,
		signature: row.signature,
		status: row.status as AgentCommand['status'],
		issuedAt: row.issued_at,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		exitCode: row.exit_code,
		stdout: row.stdout,
		stderr: row.stderr,
		timeoutSeconds: row.timeout_seconds,
		userId: row.user_id,
		createdAt: row.created_at
	};
}

// --- Dispatch ---

/**
 * Sign + insert a command for an agent. Uses the per-agent HMAC secret
 * established at enrollment so compromise of one agent can't forge
 * commands for any other agent.
 *
 * The `payloadStr` we sign is preserved exactly in the DB — the agent
 * receives the same bytes and recomputes the HMAC over them. Any
 * re-marshaling (e.g. JSON.stringify on retrieval) would shift byte
 * order and break verification.
 */
export function dispatchCommand(agentId: string, type: AgentCommandType, payload: Record<string, unknown>, userId: string, timeoutSeconds?: number): AgentCommand {
	const id = generateId();
	const issuedAt = new Date().toISOString();
	const payloadStr = JSON.stringify(payload);

	const settings = getSetting<RmmSettings>('rmm');
	const timeout = timeoutSeconds ?? settings?.commandTimeoutSeconds ?? 300;

	const row = stmtGetAgentHmac.get(agentId) as { hmac_secret: string } | undefined;
	if (!row) throw new Error('Agent not found: ' + agentId);
	const signature = signCommand(id, agentId, type, payloadStr, issuedAt, row.hmac_secret);

	stmtInsertCommand.run(id, agentId, type, payloadStr, signature, 'pending', issuedAt, timeout, userId);
	recordChange('agent', agentId, 'update', {
		command: { old: null, new: { id, type, payload } }
	}, userId);

	return getCommand(id)!;
}

export function getPendingCommands(agentId: string): AgentCommand[] {
	const rows = stmtGetPendingCommands.all(agentId) as CommandRow[];
	return rows.map(rowToCommand);
}

/**
 * Return pending commands with the raw payload string preserved exactly as
 * signed. Used by the agent-facing checkin endpoint so the agent receives
 * the same bytes the server HMAC'd over. Re-stringifying `cmd.payload`
 * after JSON.parse is NOT byte-stable (key order, escaping) and would
 * break signature verification.
 */
export function getPendingCommandsRaw(agentId: string): Array<{
	id: string; agentId: string; type: string; payloadRaw: string; payload: Record<string, unknown>;
	signature: string; issuedAt: string; timeoutSeconds: number;
}> {
	const rows = stmtGetPendingCommands.all(agentId) as CommandRow[];
	return rows.map(row => {
		let payload: Record<string, unknown> = {};
		try { payload = JSON.parse(row.payload); } catch { /* empty */ }
		return {
			id: row.id,
			agentId: row.agent_id,
			type: row.type,
			payloadRaw: row.payload,
			payload,
			signature: row.signature,
			issuedAt: row.issued_at,
			timeoutSeconds: row.timeout_seconds
		};
	});
}

export function getCommand(id: string): AgentCommand | null {
	const row = stmtGetCommand.get(id) as CommandRow | undefined;
	return row ? rowToCommand(row) : null;
}

export function getCommandHistory(agentId: string, limit = 50): AgentCommand[] {
	const rows = stmtGetCommandHistory.all(agentId, limit) as CommandRow[];
	return rows.map(rowToCommand);
}

// --- Result processing ---

export function processCommandResult(commandId: string, agentId: string, result: {
	status: 'running' | 'completed' | 'failed';
	exitCode: number | null;
	stdout: string;
	stderr: string;
	startedAt: string | null;
	completedAt: string | null;
}): void {
	stmtUpdateCommandResult.run(
		result.status,
		result.exitCode,
		result.stdout,
		result.stderr,
		result.startedAt,
		result.completedAt,
		commandId,
		agentId
	);
}

// --- Bulk dispatch ---

/**
 * Dispatch the same command to a set of agents resolved by tag. Each
 * dispatch is its own audit-log entry and its own HMAC-signed payload — a
 * compromise of one agent still can't replay against the others.
 *
 * Empty target set throws — caller should pre-resolve to give a meaningful
 * error to the operator. Failures on individual agents are collected but
 * don't abort the rest of the fan-out.
 */
export function bulkDispatchCommand(
	agentIds: string[],
	type: AgentCommandType,
	payload: Record<string, unknown>,
	userId: string,
	timeoutSeconds?: number
): { dispatched: AgentCommand[]; failed: { agentId: string; error: string }[] } {
	const dispatched: AgentCommand[] = [];
	const failed: { agentId: string; error: string }[] = [];
	for (const agentId of agentIds) {
		try {
			dispatched.push(dispatchCommand(agentId, type, payload, userId, timeoutSeconds));
		} catch (e) {
			failed.push({ agentId, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return { dispatched, failed };
}

// --- Expiry ---

export function expirePendingCommands(): void {
	const settings = getSetting<RmmSettings>('rmm');
	const timeout = settings?.commandTimeoutSeconds ?? 300;
	stmtExpireCommands.run(`-${timeout} seconds`);
}
