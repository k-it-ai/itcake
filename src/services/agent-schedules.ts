import { db, generateId } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { ServiceError } from '$lib/server/service-error.js';
import { dispatchCommand } from './agent-commands.js';
import { nextCronRun, parseCron, nextRunAt } from '$lib/server/cron.js';
import type { AgentCommandType } from '$lib/types.js';

type ScheduleType = AgentCommandType;

interface AgentSchedule {
	id: string;
	agentId: string;
	name: string;
	type: ScheduleType;
	payload: Record<string, unknown>;
	cronExpression: string;
	timeoutSeconds: number;
	enabled: boolean;
	lastRunAt: string | null;
	nextRunAt: string;
	userId: string;
	createdAt: string;
	updatedAt: string;
}

interface ScheduleRow {
	id: string;
	agent_id: string;
	name: string;
	type: string;
	payload: string;
	cron_expression: string;
	timeout_seconds: number;
	enabled: number;
	last_run_at: string | null;
	next_run_at: string;
	user_id: string;
	created_at: string;
	updated_at: string;
}

const SELECT = 'id, agent_id, name, type, payload, cron_expression, timeout_seconds, enabled, last_run_at, next_run_at, user_id, created_at, updated_at';

const stmtInsert = db.prepare(
	`INSERT INTO agent_schedules (id, agent_id, name, type, payload, cron_expression, timeout_seconds, enabled, next_run_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGet = db.prepare(`SELECT ${SELECT} FROM agent_schedules WHERE id = ?`);
const stmtListByAgent = db.prepare(`SELECT ${SELECT} FROM agent_schedules WHERE agent_id = ? ORDER BY created_at DESC`);
const stmtUpdate = db.prepare(
	`UPDATE agent_schedules SET name = ?, type = ?, payload = ?, cron_expression = ?, timeout_seconds = ?, enabled = ?, next_run_at = ?, updated_at = datetime('now') WHERE id = ?`
);
const stmtToggle = db.prepare(
	`UPDATE agent_schedules SET enabled = ?, updated_at = datetime('now') WHERE id = ?`
);
const stmtDelete = db.prepare('DELETE FROM agent_schedules WHERE id = ?');
// datetime(col) normalises ISO column vs `datetime('now')` space format —
// without it same-UTC-day schedules wouldn't fire until date rollover.
const stmtDue = db.prepare(
	"SELECT " + SELECT + " FROM agent_schedules WHERE enabled = 1 AND datetime(next_run_at) <= datetime('now') LIMIT 100"
);
const stmtMarkRan = db.prepare(
	"UPDATE agent_schedules SET last_run_at = datetime('now'), next_run_at = ?, updated_at = datetime('now') WHERE id = ?"
);

function rowToSchedule(r: ScheduleRow): AgentSchedule {
	let payload: Record<string, unknown> = {};
	try { payload = JSON.parse(r.payload); } catch { /* corrupt — surface as empty */ }
	return {
		id: r.id,
		agentId: r.agent_id,
		name: r.name,
		type: r.type as ScheduleType,
		payload,
		cronExpression: r.cron_expression,
		timeoutSeconds: r.timeout_seconds,
		enabled: r.enabled === 1,
		lastRunAt: r.last_run_at,
		nextRunAt: r.next_run_at,
		userId: r.user_id,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

export function listSchedules(agentId: string): AgentSchedule[] {
	const rows = stmtListByAgent.all(agentId) as ScheduleRow[];
	return rows.map(rowToSchedule);
}

export function getSchedule(id: string): AgentSchedule | null {
	const row = stmtGet.get(id) as ScheduleRow | undefined;
	return row ? rowToSchedule(row) : null;
}

function validateInput(name: string, cronExpression: string): void {
	if (!name.trim()) throw new ServiceError('error.scheduleNameRequired');
	try {
		parseCron(cronExpression);
	} catch {
		throw new ServiceError('error.scheduleCronInvalid');
	}
}

export function createSchedule(input: {
	agentId: string;
	name: string;
	type: ScheduleType;
	payload: Record<string, unknown>;
	cronExpression: string;
	timeoutSeconds?: number;
	enabled?: boolean;
}, userId: string): AgentSchedule {
	validateInput(input.name, input.cronExpression);
	const id = generateId();
	const next = nextCronRun(input.cronExpression).toISOString();
	const enabled = input.enabled ?? true;
	const timeout = Math.min(3600, Math.max(5, input.timeoutSeconds ?? 300));
	stmtInsert.run(
		id,
		input.agentId,
		input.name.slice(0, 200),
		input.type,
		JSON.stringify(input.payload ?? {}),
		input.cronExpression,
		timeout,
		enabled ? 1 : 0,
		next,
		userId
	);
	recordChange('agent', input.agentId, 'update', { schedule: { old: null, new: { id, name: input.name } } }, userId);
	return getSchedule(id)!;
}

export function updateSchedule(id: string, input: {
	name?: string;
	type?: ScheduleType;
	payload?: Record<string, unknown>;
	cronExpression?: string;
	timeoutSeconds?: number;
	enabled?: boolean;
}, userId: string): AgentSchedule | null {
	const existing = getSchedule(id);
	if (!existing) return null;
	const name = input.name ?? existing.name;
	const type = input.type ?? existing.type;
	const payload = input.payload ?? existing.payload;
	const cronExpression = input.cronExpression ?? existing.cronExpression;
	const timeoutSeconds = Math.min(3600, Math.max(5, input.timeoutSeconds ?? existing.timeoutSeconds));
	const enabled = input.enabled ?? existing.enabled;
	validateInput(name, cronExpression);
	const next = nextCronRun(cronExpression).toISOString();
	stmtUpdate.run(name.slice(0, 200), type, JSON.stringify(payload), cronExpression, timeoutSeconds, enabled ? 1 : 0, next, id);
	recordChange('agent', existing.agentId, 'update', { schedule: { old: existing.name, new: name } }, userId);
	return getSchedule(id);
}

export function toggleSchedule(id: string, enabled: boolean, userId: string): AgentSchedule | null {
	const existing = getSchedule(id);
	if (!existing) return null;
	stmtToggle.run(enabled ? 1 : 0, id);
	recordChange('agent', existing.agentId, 'update', { scheduleEnabled: { old: existing.enabled, new: enabled } }, userId);
	return getSchedule(id);
}

export function deleteSchedule(id: string, userId: string): boolean {
	const existing = getSchedule(id);
	if (!existing) return false;
	stmtDelete.run(id);
	recordChange('agent', existing.agentId, 'delete', { schedule: { old: existing.name, new: null } }, userId);
	return true;
}

export function processDueSchedules(now: Date = new Date()): number {
	const rows = stmtDue.all() as ScheduleRow[];
	let dispatched = 0;
	for (const r of rows) {
		const schedule = rowToSchedule(r);
		try {
			dispatchCommand(schedule.agentId, schedule.type, schedule.payload, 'system', schedule.timeoutSeconds);
			dispatched++;
		} catch (e) {
			console.error(`[schedule] dispatch failed for ${schedule.id} (${schedule.name}):`, e instanceof Error ? e.message : e);
		}
		// Always advance next_run_at so a permanently-broken schedule
		// doesn't get stuck firing every tick.
		try {
			const next = nextRunAt(parseCron(schedule.cronExpression), now).toISOString();
			stmtMarkRan.run(next, schedule.id);
		} catch (e) {
			console.error(`[schedule] could not roll forward ${schedule.id}:`, e instanceof Error ? e.message : e);
		}
	}
	return dispatched;
}
