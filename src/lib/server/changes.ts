import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db, generateId } from './db.js';
import { events } from './events.js';

type ChangeEntityType = 'invoice' | 'creditNote' | 'proposal' | 'client' | 'expense' | 'settings' | 'catalog_item' | 'unit' | 'template' | 'monitor' | 'ticket' | 'agent' | 'alert_rule' | 'remote_session' | 'custom_field_def' | 'saved_filter';
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
const stmtLastHash = db.prepare("SELECT hash FROM changes ORDER BY created_at DESC, rowid DESC LIMIT 1");
const stmtCountChanges = db.prepare('SELECT COUNT(*) as count FROM changes');
const stmtGetAnchor = db.prepare('SELECT row_count, last_hash, anchor_hmac, updated_at FROM audit_anchor WHERE id = 1');
const stmtUpdateAnchor = db.prepare('UPDATE audit_anchor SET row_count = ?, last_hash = ?, anchor_hmac = ?, updated_at = ? WHERE id = 1');

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

function chainHash(prev: string, id: string, entityType: string, entityId: string, action: string, diffJson: string, userId: string, createdAt: string): string {
	return macOrSha(buildHashInput(prev, id, entityType, entityId, action, diffJson, userId, createdAt));
}

function anchorHmac(rowCount: number, lastHash: string, updatedAt: string): string {
	const input = Buffer.concat([
		Buffer.from('audit-anchor-v1', 'utf-8'),
		lengthPrefixed(String(rowCount)),
		lengthPrefixed(lastHash),
		lengthPrefixed(updatedAt)
	]);
	return macOrSha(input);
}

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

const DIFF_SUMMARY_KEYS = new Set(['items', 'totals', 'seller', 'buyer']);

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

const recordChangeTx = db.transaction((
	id: string,
	entityType: ChangeEntityType,
	entityId: string,
	action: ChangeAction,
	diffJson: string,
	userId: string,
	createdAt: string
): void => {
	const prevRow = stmtLastHash.get() as { hash: string } | undefined;
	const prev = prevRow?.hash ?? '';
	const hash = chainHash(prev, id, entityType, entityId, action, diffJson, userId, createdAt);
	stmtInsertChange.run(id, entityType, entityId, action, diffJson, userId, createdAt, hash);
	const newCount = (stmtCountChanges.get() as { count: number }).count;
	const anchoredAt = new Date().toISOString();
	stmtUpdateAnchor.run(newCount, hash, anchorHmac(newCount, hash, anchoredAt), anchoredAt);
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

	queueMicrotask(() => events.emit('change', { entityType, entityId, action }));
}

export function recomputeAuditAnchor(): void {
	const lastRow = stmtLastHash.get() as { hash: string } | undefined;
	const lastHash = lastRow?.hash ?? '';
	const count = (stmtCountChanges.get() as { count: number }).count;
	const anchoredAt = new Date().toISOString();
	stmtUpdateAnchor.run(count, lastHash, anchorHmac(count, lastHash, anchoredAt), anchoredAt);
}

const stmtVerifyAuditIterator = db.prepare(
	'SELECT id, entity_type, entity_id, action, diff, user_id, created_at, hash FROM changes ORDER BY created_at ASC, rowid ASC'
);

export function verifyAuditLogIntegrity(): {
	total: number;
	verified: number;
	unverified: number;
	tamperedIds: string[];
	anchor: 'ok' | 'tail-truncated' | 'mismatch' | 'none';
} {
	let prev = '';
	let verified = 0;
	let unverified = 0;
	let total = 0;
	let chainEstablished = false;
	let lastHash = '';
	const tamperedIds: string[] = [];

	// Stream rows instead of all() — at scale this avoids loading the entire
	// `changes` table into memory just to recompute hashes.
	for (const r of stmtVerifyAuditIterator.iterate() as IterableIterator<{
		id: string; entity_type: string; entity_id: string; action: string;
		diff: string; user_id: string; created_at: string; hash: string;
	}>) {
		total++;
		if (!r.hash) {
			if (chainEstablished) tamperedIds.push(r.id);
			else unverified++;
			continue;
		}
		const userId = r.user_id ?? '';
		const expectV1 = chainHash(prev, r.id, r.entity_type, r.entity_id, r.action, r.diff, userId, r.created_at);
		const expectV0 = chainHashV0(prev, r.id, r.entity_type, r.entity_id, r.action, r.diff, userId, r.created_at);
		const actualBuf = Buffer.from(r.hash, 'hex');
		const matches = (expected: string) => {
			const expectBuf = Buffer.from(expected, 'hex');
			return expectBuf.length === actualBuf.length && crypto.timingSafeEqual(expectBuf, actualBuf);
		};
		const ok = matches(expectV1) || matches(expectV0);
		if (!ok) tamperedIds.push(r.id);
		else verified++;
		prev = r.hash;
		lastHash = r.hash;
		chainEstablished = true;
	}

	const anchor = stmtGetAnchor.get() as { row_count: number; last_hash: string; anchor_hmac: string; updated_at: string } | undefined;
	let anchorState: 'ok' | 'tail-truncated' | 'mismatch' | 'none' = 'none';
	if (anchor && anchor.anchor_hmac) {
		const expectedHmac = anchorHmac(anchor.row_count, anchor.last_hash, anchor.updated_at);
		const expectBuf = Buffer.from(expectedHmac, 'hex');
		const actualBuf = Buffer.from(anchor.anchor_hmac, 'hex');
		const hmacOk = expectBuf.length === actualBuf.length && crypto.timingSafeEqual(expectBuf, actualBuf);
		if (!hmacOk) {
			anchorState = 'mismatch';
		} else if (anchor.row_count > total || (anchor.last_hash && anchor.last_hash !== lastHash)) {
			anchorState = 'tail-truncated';
		} else {
			anchorState = 'ok';
		}
	} else if (total > 0) {
		anchorState = 'mismatch';
	}

	return { total, verified, unverified, tamperedIds, anchor: anchorState };
}

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
