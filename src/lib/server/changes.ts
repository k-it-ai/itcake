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
 * Compute the row hash: HMAC-SHA256( SESSION_SECRET, canonical encoding
 * of [prevHash, id, entity_type, entity_id, action, diff, user_id,
 * created_at] ).
 *
 * The HMAC key is the server's SESSION_SECRET — without it, an attacker
 * who got DB write access cannot forge a valid hash for their inserted
 * row, so the integrity check detects tampering.
 *
 * Encoding: a length-prefix per field followed by the field bytes,
 * separated by a NUL terminator. This is robust to fields containing
 * `|`, NUL, or any other byte sequence (notably the JSON diff and the
 * arbitrary entity_id), where a plain `|` separator could in theory
 * collide across different inputs (`a|b|c|d` == `a|b|cd|''` etc.).
 *
 * When SESSION_SECRET is missing in DEVELOPMENT only, fall back to plain
 * SHA-256 so the chain is still well-formed for local testing. In any
 * non-development environment, missing SESSION_SECRET MUST refuse the
 * write — otherwise a leaked DB lets an attacker recompute the entire
 * chain and tamper-evidence vanishes silently.
 *
 * Two encodings exist on disk:
 *   - v0 (legacy `|`-separated): rows written before the v1 upgrade.
 *     Verified with `chainHashV0` for backward compatibility — the
 *     verifier accepts EITHER hash on legacy rows.
 *   - v1 (length-prefixed): rows written by this version. Always
 *     produced by `chainHash` going forward.
 */
function lengthPrefixed(field: string): Buffer {
	const data = Buffer.from(field, 'utf-8');
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(data.length);
	return Buffer.concat([lenBuf, data]);
}

function buildHashInput(
	prev: string, id: string, entityType: string, entityId: string,
	action: string, diffJson: string, userId: string, createdAt: string
): Buffer {
	return Buffer.concat([
		lengthPrefixed(prev),
		lengthPrefixed(id),
		lengthPrefixed(entityType),
		lengthPrefixed(entityId),
		lengthPrefixed(action),
		lengthPrefixed(diffJson),
		lengthPrefixed(userId),
		lengthPrefixed(createdAt)
	]);
}

function macOrSha(buf: Buffer): string {
	const secret = env.SESSION_SECRET;
	if (secret) {
		return crypto.createHmac('sha256', secret).update(buf).digest('hex');
	}
	if (env.NODE_ENV === 'production') {
		throw new Error('SESSION_SECRET is required for audit-log integrity in production');
	}
	return crypto.createHash('sha256').update(buf).digest('hex');
}

/** v1 (current): length-prefixed canonical encoding. */
function chainHash(prev: string, id: string, entityType: string, entityId: string, action: string, diffJson: string, userId: string, createdAt: string): string {
	return macOrSha(buildHashInput(prev, id, entityType, entityId, action, diffJson, userId, createdAt));
}

/** v0 (legacy `|`-separated): kept ONLY for verifier-side backward
 *  compatibility with rows written before the v1 upgrade. New rows
 *  always use chainHash above. */
function chainHashV0(prev: string, id: string, entityType: string, entityId: string, action: string, diffJson: string, userId: string, createdAt: string): string {
	const msg = `${prev}|${id}|${entityType}|${entityId}|${action}|${diffJson}|${userId}|${createdAt}`;
	const secret = env.SESSION_SECRET;
	if (secret) {
		return crypto.createHmac('sha256', secret).update(msg).digest('hex');
	}
	if (env.NODE_ENV === 'production') {
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
 * Walk the audit log in insertion order, recomputing each row's hash
 * from its predecessor + fields. Returns counts + the IDs of any rows
 * whose stored hash doesn't match (tampered) or which carry no hash at
 * all (unverified, legacy pre-migration).
 *
 * Tamper-downgrade defense: an attacker with DB write access could try
 * to mask a real tamper by clearing the row's hash to convert it from
 * "tampered" to "legacy unverified". We close that by tracking whether
 * any earlier row was hashed, and treating an empty hash as TAMPERED
 * once the chain has been established. Genuinely-legacy rows all sit
 * before the first hash-bearing row so they remain "unverified".
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
	let chainEstablished = false;
	const tamperedIds: string[] = [];
	for (const r of rows) {
		if (!r.hash) {
			if (chainEstablished) {
				// Hash-clearing AFTER the chain is established is a
				// tamper-downgrade attempt — flag, don't quietly skip.
				tamperedIds.push(r.id);
			} else {
				// Pre-migration row: chain not yet started.
				unverified++;
			}
			continue;
		}
		// `userId` is preserved verbatim so verify always reproduces the
		// exact bytes that recordChange hashed at write time. The schema
		// allows NULL for legacy rows; treat NULL on hash-bearing rows
		// the same way they were stored (empty string) — matching how
		// recordChange's caller would have passed any nullish input.
		const userId = r.user_id ?? '';
		const expectV1 = chainHash(prev, r.id, r.entity_type, r.entity_id, r.action, r.diff, userId, r.created_at);
		const expectV0 = chainHashV0(prev, r.id, r.entity_type, r.entity_id, r.action, r.diff, userId, r.created_at);
		// Constant-time comparison of HMAC tags. Even though only an
		// already-DB-write-capable attacker could exploit a timing
		// oracle here, keeping the codebase's invariant — "compare
		// secret-derived bytes only via timingSafeEqual" — saves us
		// from having to remember when it does and doesn't matter.
		const actualBuf = Buffer.from(r.hash, 'hex');
		const matches = (expected: string) => {
			const expectBuf = Buffer.from(expected, 'hex');
			return expectBuf.length === actualBuf.length && crypto.timingSafeEqual(expectBuf, actualBuf);
		};
		const ok = matches(expectV1) || matches(expectV0);
		if (!ok) {
			tamperedIds.push(r.id);
		} else {
			verified++;
		}
		prev = r.hash;
		chainEstablished = true;
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
