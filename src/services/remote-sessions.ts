import crypto from 'node:crypto';
import { db, generateId, parseSqliteUtc } from '$lib/server/db.js';
import { hashAgentToken } from '$lib/server/agent-auth.js';
import { recordChange } from '$lib/server/changes.js';
import type { RemoteSession, RemoteDesktopProtocol } from '$lib/types.js';

interface RemoteSessionRow {
	id: string;
	agent_id: string;
	user_id: string;
	token_hash: string;
	protocol: string;
	expires_at: string;
	consumed_at: string | null;
	started_at: string | null;
	ended_at: string | null;
	recording_path: string | null;
	client_ip: string;
	user_agent: string;
	created_at: string;
}

const SELECT = 'id, agent_id, user_id, token_hash, protocol, expires_at, consumed_at, started_at, ended_at, recording_path, client_ip, user_agent, created_at';

const stmtInsert = db.prepare(
	`INSERT INTO remote_sessions (id, agent_id, user_id, token_hash, protocol, expires_at, client_ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetByToken = db.prepare(`SELECT ${SELECT} FROM remote_sessions WHERE token_hash = ?`);
const stmtGet = db.prepare(`SELECT ${SELECT} FROM remote_sessions WHERE id = ?`);
const stmtListByAgent = db.prepare(`SELECT ${SELECT} FROM remote_sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`);
const stmtConsume = db.prepare("UPDATE remote_sessions SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL");
const stmtMarkStarted = db.prepare("UPDATE remote_sessions SET started_at = datetime('now'), recording_path = ? WHERE id = ? AND started_at IS NULL");
const stmtMarkEnded = db.prepare("UPDATE remote_sessions SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL");
const stmtPrune = db.prepare("DELETE FROM remote_sessions WHERE consumed_at IS NULL AND datetime(expires_at) < datetime('now')");

function rowToSession(r: RemoteSessionRow): RemoteSession {
	return {
		id: r.id,
		agentId: r.agent_id,
		userId: r.user_id,
		protocol: r.protocol as RemoteDesktopProtocol,
		expiresAt: r.expires_at,
		consumedAt: r.consumed_at,
		startedAt: r.started_at,
		endedAt: r.ended_at,
		recordingPath: r.recording_path,
		clientIp: r.client_ip,
		userAgent: r.user_agent,
		createdAt: r.created_at
	};
}

export function createRemoteSession(input: {
	agentId: string;
	userId: string;
	protocol: RemoteDesktopProtocol;
	ttlSeconds: number;
	clientIp: string;
	userAgent: string;
}): { sessionId: string; token: string; expiresAt: string } {
	const sessionId = generateId();
	const token = crypto.randomBytes(32).toString('hex');
	const tokenHash = hashAgentToken(token);
	const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
	stmtInsert.run(
		sessionId, input.agentId, input.userId, tokenHash,
		input.protocol, expiresAt, input.clientIp, (input.userAgent || '').slice(0, 500)
	);
	recordChange('remote_session', sessionId, 'create', {
		agentId: { old: null, new: input.agentId },
		protocol: { old: null, new: input.protocol }
	}, input.userId);
	return { sessionId, token, expiresAt };
}

export function peekRemoteSession(token: string): RemoteSession | null {
	const tokenHash = hashAgentToken(token);
	const row = stmtGetByToken.get(tokenHash) as RemoteSessionRow | undefined;
	if (!row) return null;
	if (parseSqliteUtc(row.expires_at) < Date.now()) return null;
	return rowToSession(row);
}

export const consumeRemoteSession = db.transaction((token: string): RemoteSession | null => {
	const tokenHash = hashAgentToken(token);
	const row = stmtGetByToken.get(tokenHash) as RemoteSessionRow | undefined;
	if (!row) return null;
	if (row.consumed_at) return null;
	if (parseSqliteUtc(row.expires_at) < Date.now()) return null;
	const result = stmtConsume.run(row.id);
	if (result.changes === 0) return null;
	row.consumed_at = new Date().toISOString();
	return rowToSession(row);
});

export function claimRemoteSessionStart(sessionId: string, recordingPath: string | null): boolean {
	const result = stmtMarkStarted.run(recordingPath, sessionId);
	return result.changes === 1;
}

export function recordRemoteSessionConnected(sessionId: string, userId: string, recordingPath: string | null): void {
	recordChange('remote_session', sessionId, 'connect', {
		recordingPath: { old: null, new: recordingPath }
	}, userId);
}

export function markRemoteSessionEnded(sessionId: string, userId: string): void {
	const result = stmtMarkEnded.run(sessionId);
	if (result.changes === 0) return;
	recordChange('remote_session', sessionId, 'disconnect', {}, userId);
}

export function getRemoteSession(id: string): RemoteSession | null {
	const row = stmtGet.get(id) as RemoteSessionRow | undefined;
	return row ? rowToSession(row) : null;
}

export function listRemoteSessionsByAgent(agentId: string, limit = 50): RemoteSession[] {
	const cap = Math.min(500, Math.max(1, limit));
	return (stmtListByAgent.all(agentId, cap) as RemoteSessionRow[]).map(rowToSession);
}

export function pruneExpiredRemoteSessions(): number {
	const result = stmtPrune.run();
	return result.changes;
}
