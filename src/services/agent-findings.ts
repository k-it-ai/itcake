import crypto from 'node:crypto';
import { db, generateId } from '#lib/server/db.js';
import { recordChange } from '#lib/server/changes.js';
import { events } from '#lib/server/events.js';
import { invalidateAgentPostureCache } from './security-posture.js';
import type { AgentFinding, FindingCategory, FindingSeverity, FindingState } from '#lib/types.js';

interface FindingRow {
	id: string;
	agent_id: string;
	category: string;
	severity: string;
	title: string;
	evidence: string;
	fingerprint: string;
	state: string;
	first_seen_at: string;
	last_seen_at: string;
	resolved_at: string | null;
	user_id: string | null;
}

const SELECT = 'id, agent_id, category, severity, title, evidence, fingerprint, state, first_seen_at, last_seen_at, resolved_at, user_id';

const stmtUpsert = db.prepare(
	`INSERT INTO agent_findings (id, agent_id, category, severity, title, evidence, fingerprint, state)
	 VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
	 ON CONFLICT(agent_id, category, fingerprint) DO UPDATE SET
	   severity = excluded.severity,
	   title = excluded.title,
	   evidence = excluded.evidence,
	   last_seen_at = datetime('now'),
	   state = CASE WHEN agent_findings.state = 'resolved' THEN 'open' ELSE agent_findings.state END,
	   resolved_at = CASE WHEN agent_findings.state = 'resolved' THEN NULL ELSE agent_findings.resolved_at END
	`
);
const stmtListByAgent = db.prepare(`SELECT ${SELECT} FROM agent_findings WHERE agent_id = ? ORDER BY last_seen_at DESC LIMIT ?`);
const stmtListByCategory = db.prepare(`SELECT ${SELECT} FROM agent_findings WHERE agent_id = ? AND category = ? ORDER BY last_seen_at DESC LIMIT ?`);
const stmtCount = db.prepare("SELECT category, COUNT(*) AS n FROM agent_findings WHERE state = 'open' GROUP BY category");
const stmtGet = db.prepare(`SELECT ${SELECT} FROM agent_findings WHERE id = ?`);
const stmtUpdateState = db.prepare(
	`UPDATE agent_findings SET state = ?, resolved_at = CASE WHEN ? IN ('resolved', 'accepted', 'false_positive') THEN datetime('now') ELSE NULL END, user_id = ? WHERE id = ?`
);
const stmtPruneResolved = db.prepare("DELETE FROM agent_findings WHERE state IN ('resolved', 'accepted', 'false_positive') AND datetime(resolved_at) < datetime('now', '-180 days')");

function rowToFinding(r: FindingRow): AgentFinding {
	let evidence: Record<string, unknown> = {};
	try { evidence = JSON.parse(r.evidence); } catch { /* keep default */ }
	return {
		id: r.id,
		agentId: r.agent_id,
		category: r.category as FindingCategory,
		severity: r.severity as FindingSeverity,
		title: r.title,
		evidence,
		fingerprint: r.fingerprint,
		state: r.state as FindingState,
		firstSeenAt: r.first_seen_at,
		lastSeenAt: r.last_seen_at,
		resolvedAt: r.resolved_at,
		userId: r.user_id
	};
}

export function fingerprintOf(category: FindingCategory, parts: (string | number | null | undefined)[]): string {
	const norm = parts.map(p => p == null ? '' : String(p)).join('\u0000');
	return crypto.createHash('sha256').update(`${category}\u0000${norm}`).digest('hex').slice(0, 32);
}

export function recordFinding(input: {
	agentId: string;
	category: FindingCategory;
	severity: FindingSeverity;
	title: string;
	evidence: Record<string, unknown>;
	fingerprint: string;
}): AgentFinding {
	const id = generateId();
	stmtUpsert.run(
		id, input.agentId, input.category, input.severity,
		input.title.slice(0, 500),
		JSON.stringify(input.evidence),
		input.fingerprint
	);
	const row = db.prepare(`SELECT ${SELECT} FROM agent_findings WHERE agent_id = ? AND category = ? AND fingerprint = ?`)
		.get(input.agentId, input.category, input.fingerprint) as FindingRow | undefined;
	if (!row) throw new Error('agent-findings: failed to fetch upserted row');
	events.emit('agent_finding', { id: row.id, agentId: row.agent_id, category: row.category, severity: row.severity, state: row.state });
	invalidateAgentPostureCache(row.agent_id);
	return rowToFinding(row);
}

export function listFindingsByAgent(agentId: string, limit = 100): AgentFinding[] {
	const cap = Math.min(500, Math.max(1, limit));
	return (stmtListByAgent.all(agentId, cap) as FindingRow[]).map(rowToFinding);
}

export function listFindingsByCategory(agentId: string, category: FindingCategory, limit = 100): AgentFinding[] {
	const cap = Math.min(500, Math.max(1, limit));
	return (stmtListByCategory.all(agentId, category, cap) as FindingRow[]).map(rowToFinding);
}

export function listAllFindings(filter: { category?: FindingCategory; state?: FindingState; limit?: number } = {}): AgentFinding[] {
	const cap = Math.min(10000, Math.max(1, filter.limit ?? 5000));
	const where: string[] = [];
	const params: unknown[] = [];
	if (filter.category) { where.push('category = ?'); params.push(filter.category); }
	if (filter.state) { where.push('state = ?'); params.push(filter.state); }
	const sql = `SELECT * FROM agent_findings${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY last_seen_at DESC LIMIT ?`;
	const rows = db.prepare(sql).all(...params, cap) as FindingRow[];
	return rows.map(rowToFinding);
}

function getFinding(id: string): AgentFinding | null {
	const row = stmtGet.get(id) as FindingRow | undefined;
	return row ? rowToFinding(row) : null;
}

// expectedAgentId required to scope updates — finding ids alone allow cross-agent state writes.
export function updateFindingState(
	id: string,
	state: FindingState,
	userId: string,
	expectedAgentId?: string
): AgentFinding | null {
	const existing = getFinding(id);
	if (!existing) return null;
	if (expectedAgentId !== undefined && existing.agentId !== expectedAgentId) {
		return null;
	}
	stmtUpdateState.run(state, state, userId, id);
	recordChange('agent_finding', id, 'update', { state: { old: existing.state, new: state } }, userId);
	invalidateAgentPostureCache(existing.agentId);
	return getFinding(id);
}

export function getOpenFindingCounts(): Record<string, number> {
	const rows = stmtCount.all() as { category: string; n: number }[];
	const out: Record<string, number> = {};
	for (const r of rows) out[r.category] = r.n;
	return out;
}

export function pruneOldResolvedFindings(): number {
	return stmtPruneResolved.run().changes;
}
