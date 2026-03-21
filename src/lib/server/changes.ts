import { db, generateId } from './db.js';
import { events } from './events.js';

type ChangeEntityType = 'invoice' | 'creditNote' | 'proposal' | 'client' | 'expense' | 'settings' | 'catalog_item' | 'unit' | 'template' | 'monitor' | 'ticket' | 'agent';
type ChangeAction = 'create' | 'update' | 'delete' | 'status_change' | 'reopen' | 'send_email';

interface ChangeRecord {
	id: string;
	entityType: ChangeEntityType;
	entityId: string;
	action: ChangeAction;
	diff: Record<string, { old: unknown; new: unknown }>;
	userId: string;
	createdAt: string;
}

const stmtInsertChange = db.prepare(
	'INSERT INTO changes (id, entity_type, entity_id, action, diff, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

// Keys to exclude from full-value diff storage to avoid bloating the audit log
const DIFF_SUMMARY_KEYS = new Set(['items', 'totals', 'seller', 'buyer']);

/**
 * Compute a shallow diff between old and new objects.
 * For bulky nested keys, only record whether they changed, not the full value.
 */
export function computeDiff(
	oldObj: Record<string, unknown>,
	newObj: Record<string, unknown>
): Record<string, { old: unknown; new: unknown }> {
	const diff: Record<string, { old: unknown; new: unknown }> = {};
	const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

	for (const key of allKeys) {
		const oldVal = oldObj[key];
		const newVal = newObj[key];
		const oldStr = JSON.stringify(oldVal);
		const newStr = JSON.stringify(newVal);
		if (oldStr !== newStr) {
			if (DIFF_SUMMARY_KEYS.has(key)) {
				diff[key] = { old: '[changed]', new: '[changed]' };
			} else {
				diff[key] = { old: oldVal, new: newVal };
			}
		}
	}

	return diff;
}

/**
 * Record a change to the audit log.
 * Event emission is deferred via queueMicrotask so it fires after
 * any enclosing transaction commits (avoids stale SSE on rollback).
 */
export function recordChange(
	entityType: ChangeEntityType,
	entityId: string,
	action: ChangeAction,
	diff: Record<string, { old: unknown; new: unknown }>,
	userId: string
): void {
	const id = generateId();
	const createdAt = new Date().toISOString();

	stmtInsertChange.run(id, entityType, entityId, action, JSON.stringify(diff), userId, createdAt);

	// Defer emission: better-sqlite3 transactions are synchronous, so
	// queueMicrotask runs after the current synchronous task completes.
	// However, if an OUTER transaction rolls back after recordChange is called,
	// the SSE event will still fire even though the INSERT was undone. This is
	// a known limitation — the concrete risk is mitigated by wrapping recurring
	// invoice processing in a proper transaction (see recurring-invoices.ts).
	queueMicrotask(() => events.emit('change', { entityType, entityId, action }));
}

// Cached prepared statements for getChanges (3 permutations)
const stmtChangesAll = db.prepare(
	'SELECT id, entity_type, entity_id, action, diff, user_id, created_at FROM changes ORDER BY created_at DESC LIMIT ?'
);
const stmtChangesByType = db.prepare(
	'SELECT id, entity_type, entity_id, action, diff, user_id, created_at FROM changes WHERE entity_type = ? ORDER BY created_at DESC LIMIT ?'
);
const stmtChangesByTypeAndId = db.prepare(
	'SELECT id, entity_type, entity_id, action, diff, user_id, created_at FROM changes WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?'
);

type ChangeRow = {
	id: string;
	entity_type: string;
	entity_id: string;
	action: string;
	diff: string;
	user_id: string;
	created_at: string;
};

/**
 * Get recent changes, optionally filtered by entity.
 */
export function getChanges(
	limit = 50,
	entityType?: ChangeEntityType,
	entityId?: string
): ChangeRecord[] {
	let rows: ChangeRow[];

	if (entityType && entityId) {
		rows = stmtChangesByTypeAndId.all(entityType, entityId, limit) as ChangeRow[];
	} else if (entityType) {
		rows = stmtChangesByType.all(entityType, limit) as ChangeRow[];
	} else {
		rows = stmtChangesAll.all(limit) as ChangeRow[];
	}

	return rows.map((r) => {
		let diff: Record<string, { old: unknown; new: unknown }> = {};
		try { diff = JSON.parse(r.diff); } catch { /* corrupted diff — default to empty */ }
		return {
			id: r.id,
			entityType: r.entity_type as ChangeEntityType,
			entityId: r.entity_id,
			action: r.action as ChangeAction,
			diff,
			userId: r.user_id,
			createdAt: r.created_at
		};
	});
}
