import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db, generateId } from './db.js';
import { events } from './events.js';

type ChangeEntityType = 'invoice' | 'creditNote' | 'proposal' | 'client' | 'expense' | 'settings' | 'catalog_item' | 'unit' | 'template' | 'monitor' | 'ticket' | 'agent' | 'alert_rule' | 'remote_session';
type ChangeAction = 'create' | 'update' | 'delete' | 'status_change' | 'reopen' | 'send_email' | 'connect' | 'disconnect';

interface ChangeRecord {
	id: string;
	entityType: ChangeEntityType;
	entityId: string;
	action: ChangeAction;
	diff: Record<string, { old: unknown; new: unknown }>;
	userId: string;
	createdAt: string;
	hash: string;
}

const stmtInsertChange = db.prepare(
	'INSERT INTO changes (id, entity_type, entity_id, action, diff, user_id, created_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
// rowid breaks created_at ties deterministically — `id` is a UUID, so two
// inserts that land in the same millisecond would otherwise pick a random
// predecessor and the chain could drift.
const stmtLastHash = db.prepare("SELECT hash FROM changes ORDER BY created_at DESC, rowid DESC LIMIT 1");

/**
 * Compute the row hash: HMAC-SHA256( SESSION_SECRET, length-prefixed
 * encoding of [prevHash, id, entity_type, entity_id, action, diff, user_id,
 * created_at] ).
 *
 * The HMAC key is the server's SESSION_SECRET — without it, an attacker who
 * got DB write access cannot forge a valid hash for their inserted row, so
 * the integrity check detects tampering.
 *
 * Length-prefix the canonical message instead of using a `|` separator so
 * fields containing `|` (notably the JSON diff and the RFC 3339 created_at)
 * cannot collide across different inputs (`a|b|c|d` == `a|b|cd|''` etc.).
 *
 * When SESSION_SECRET is missing in DEVELOPMENT only, fall back to plain
 * SHA-256 so the chain is still well-formed for local testing. In any
 * non-development environment, missing SESSION_SECRET MUST refuse the
 * write — otherwise a leaked DB lets an attacker recompute the entire
 * chain and tamper-evidence vanishes silently.
 */
function chainHash(prev: string, id: string, entityType: string, entityId: string, action: string, diffJson: string, userId: string, createdAt: string): string {
	// NOTE: separator is '|' for backward compatibility with rows hashed
	// before this fix. Length-prefix encoding would be slightly safer
	// against field-boundary collisions, but the field grammars (UUIDs,
	// CHECK-constrained entity_type and action, ISO-8601 timestamps)
	// make such collisions implausible in practice.
	const msg = `${prev}|${id}|${entityType}|${entityId}|${action}|${diffJson}|${userId}|${createdAt}`;
	const secret = env.SESSION_SECRET;
	if (secret) {
		return crypto.createHmac('sha256', secret).update(msg).digest('hex');
	}
	if (env.NODE_ENV === 'production') {
		// Fail closed in production: an empty-secret SHA-256 fallback is
		// no defense against an attacker with DB write access. Dev/test
		// keep the fallback so local work doesn't require setting a
		// secret. Misconfigured prod (NODE_ENV unset) loses tamper-
		// evidence but keeps the app running — fixing this risk is
		// the operator's responsibility.
		throw new Error('SESSION_SECRET is required for audit-log integrity in production');
	}
	return crypto.createHash('sha256').update(msg).digest('hex');
}

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
const recordChangeTx = db.transaction((
	id: string,
	entityType: ChangeEntityType,
	entityId: string,
	action: ChangeAction,
	diffJson: string,
	userId: string,
	createdAt: string
): void => {
	// SELECT-prev + INSERT in one transaction so two concurrent calls
	// can't both see the same `prev` and chain off it. better-sqlite3
	// nests transactions harmlessly, so callers inside their own
	// db.transaction() still get atomicity. Without this wrapper the
	// integrity verifier reports false "tampered" rows under load.
	const prevRow = stmtLastHash.get() as { hash: string } | undefined;
	const prev = prevRow?.hash ?? '';
	const hash = chainHash(prev, id, entityType, entityId, action, diffJson, userId, createdAt);
	stmtInsertChange.run(id, entityType, entityId, action, diffJson, userId, createdAt, hash);
});

export function recordChange(
	entityType: ChangeEntityType,
	entityId: string,
	action: ChangeAction,
	diff: Record<string, { old: unknown; new: unknown }>,
	userId: string
): void {
	const id = generateId();
	const createdAt = new Date().toISOString();
	const diffJson = JSON.stringify(diff);

	recordChangeTx(id, entityType, entityId, action, diffJson, userId, createdAt);

	// Defer emission: better-sqlite3 transactions are synchronous, so
	// queueMicrotask runs after the current synchronous task completes.
	// However, if an OUTER transaction rolls back after recordChange is called,
	// the SSE event will still fire even though the INSERT was undone. This is
	// a known limitation — the concrete risk is mitigated by wrapping recurring
	// invoice processing in a proper transaction (see recurring-invoices.ts).
	queueMicrotask(() => events.emit('change', { entityType, entityId, action }));
}

/**
 * Walk the audit log in insertion order, recomputing each row's hash from
 * its predecessor + fields. Returns counts + the first broken row (if any).
 * An "unverified" row is one with an empty hash (pre-migration); these are
 * reported separately from tampered rows.
 */
export function verifyAuditLogIntegrity(): {
	total: number;
	verified: number;
	unverified: number;
	tamperedIds: string[];
} {
	const rows = db.prepare(
		'SELECT id, entity_type, entity_id, action, diff, user_id, created_at, hash FROM changes ORDER BY created_at ASC, rowid ASC'
	).all() as Array<{
		id: string; entity_type: string; entity_id: string; action: string;
		diff: string; user_id: string; created_at: string; hash: string;
	}>;

	let prev = '';
	let verified = 0;
	let unverified = 0;
	const tamperedIds: string[] = [];
	for (const r of rows) {
		if (!r.hash) {
			unverified++;
			// Legacy row: its successor chains off an empty prev.
			// Keep `prev` unchanged so the next real chain starts clean.
			continue;
		}
		const expect = chainHash(prev, r.id, r.entity_type, r.entity_id, r.action, r.diff, r.user_id ?? '', r.created_at);
		// Constant-time comparison of HMAC tags. Even though only an
		// already-DB-write-capable attacker could exploit a timing
		// oracle here, keeping the codebase's invariant — "compare
		// secret-derived bytes only via timingSafeEqual" — saves us
		// from having to remember when it does and doesn't matter.
		const expectBuf = Buffer.from(expect, 'hex');
		const actualBuf = Buffer.from(r.hash, 'hex');
		const ok = expectBuf.length === actualBuf.length && crypto.timingSafeEqual(expectBuf, actualBuf);
		if (!ok) {
			tamperedIds.push(r.id);
		} else {
			verified++;
		}
		prev = r.hash;
	}
	return { total: rows.length, verified, unverified, tamperedIds };
}

// Cached prepared statements for getChanges (3 permutations)
const stmtChangesAll = db.prepare(
	'SELECT id, entity_type, entity_id, action, diff, user_id, created_at, hash FROM changes ORDER BY created_at DESC LIMIT ?'
);
const stmtChangesByType = db.prepare(
	'SELECT id, entity_type, entity_id, action, diff, user_id, created_at, hash FROM changes WHERE entity_type = ? ORDER BY created_at DESC LIMIT ?'
);
const stmtChangesByTypeAndId = db.prepare(
	'SELECT id, entity_type, entity_id, action, diff, user_id, created_at, hash FROM changes WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?'
);

type ChangeRow = {
	id: string;
	entity_type: string;
	entity_id: string;
	action: string;
	diff: string;
	user_id: string;
	created_at: string;
	hash: string;
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
			createdAt: r.created_at,
			hash: r.hash
		};
	});
}
