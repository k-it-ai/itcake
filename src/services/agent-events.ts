import { db, generateId, getSetting } from '#lib/server/db.js';
import { truncateChars } from '#lib/server/sanitize.js';
import type { RmmSettings } from '#lib/types.js';

export interface AgentEvent {
	id: string;
	agentId: string;
	level: 'critical' | 'error' | 'warning';
	source: string;
	message: string;
	occurredAt: string;
	receivedAt: string;
}

interface EventInput {
	level: 'critical' | 'error' | 'warning';
	source: string;
	message: string;
	occurredAt: string;
}

const stmtInsert = db.prepare(
	'INSERT INTO agent_events (id, agent_id, level, source, message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const stmtList = db.prepare(
	`SELECT id, agent_id, level, source, message, occurred_at, received_at
	 FROM agent_events WHERE agent_id = ? ORDER BY occurred_at DESC LIMIT ?`
);
const stmtListSince = db.prepare(
	`SELECT id, agent_id, level, source, message, occurred_at, received_at
	 FROM agent_events WHERE agent_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?`
);
const stmtPrune = db.prepare("DELETE FROM agent_events WHERE received_at < datetime('now', ?)");

const ingestMany = db.transaction((agentId: string, events: EventInput[]) => {
	for (const e of events) {
		stmtInsert.run(
			generateId(),
			agentId,
			e.level,
			truncateChars(e.source, 500),
			truncateChars(e.message, 2000),
			truncateChars(e.occurredAt, 100)
		);
	}
});

export function ingestEvents(agentId: string, events: EventInput[]): void {
	if (!Array.isArray(events) || events.length === 0) return;
	ingestMany(agentId, events);
}

function rowToEvent(r: {
	id: string; agent_id: string; level: string; source: string;
	message: string; occurred_at: string; received_at: string;
}): AgentEvent {
	return {
		id: r.id,
		agentId: r.agent_id,
		level: r.level as AgentEvent['level'],
		source: r.source,
		message: r.message,
		occurredAt: r.occurred_at,
		receivedAt: r.received_at
	};
}

export function listEvents(agentId: string, limit = 200, since?: string): AgentEvent[] {
	const cap = Math.min(1000, Math.max(1, limit));
	const rows = since
		? stmtListSince.all(agentId, since, cap)
		: stmtList.all(agentId, cap);
	return (rows as Parameters<typeof rowToEvent>[0][]).map(rowToEvent);
}

export function pruneOldAgentEvents(): void {
	const settings = getSetting<RmmSettings>('rmm');
	const raw = Number(settings?.metricsRetentionHours);
	const hours = Number.isFinite(raw) && raw >= 1 ? Math.min(8760, Math.trunc(raw)) : 48;
	stmtPrune.run(`-${hours} hours`);
}
