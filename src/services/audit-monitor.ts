import { db } from '$lib/server/db.js';
import { verifyAuditLogIntegrity } from '$lib/server/changes.js';
import { log } from '$lib/server/log.js';
import { recordTaskRunSync } from '$lib/server/task-runs.js';

// Persisted on a small single-row table so the dashboard can show
// "last verified, status" without re-running the whole chain on each
// page load. Re-uses the same pattern as recovery_readiness — one row,
// id pinned to 1.
db.exec(`
	CREATE TABLE IF NOT EXISTS audit_integrity_status (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		last_checked_at TEXT,
		anchor_state TEXT,
		total INTEGER NOT NULL DEFAULT 0,
		verified INTEGER NOT NULL DEFAULT 0,
		unverified INTEGER NOT NULL DEFAULT 0,
		tampered_count INTEGER NOT NULL DEFAULT 0,
		history_max_row_count INTEGER NOT NULL DEFAULT 0,
		history_truncation_detected INTEGER NOT NULL DEFAULT 0
	);
	INSERT OR IGNORE INTO audit_integrity_status (id) VALUES (1);
`);

const stmtUpdate = db.prepare(
	"UPDATE audit_integrity_status SET last_checked_at = ?, anchor_state = ?, total = ?, verified = ?, unverified = ?, tampered_count = ?, history_max_row_count = ?, history_truncation_detected = ? WHERE id = 1"
);

const stmtRead = db.prepare(
	'SELECT last_checked_at, anchor_state, total, verified, unverified, tampered_count, history_max_row_count, history_truncation_detected FROM audit_integrity_status WHERE id = 1'
);

export interface AuditIntegrityStatus {
	lastCheckedAt: string | null;
	anchorState: 'ok' | 'tail-truncated' | 'mismatch' | 'none' | null;
	total: number;
	verified: number;
	unverified: number;
	tamperedCount: number;
	historyMaxRowCount: number;
	historyTruncationDetected: boolean;
}

export function getAuditIntegrityStatus(): AuditIntegrityStatus {
	const row = stmtRead.get() as {
		last_checked_at: string | null;
		anchor_state: string | null;
		total: number;
		verified: number;
		unverified: number;
		tampered_count: number;
		history_max_row_count: number;
		history_truncation_detected: number;
	} | undefined;
	if (!row) {
		return {
			lastCheckedAt: null, anchorState: null, total: 0, verified: 0,
			unverified: 0, tamperedCount: 0, historyMaxRowCount: 0,
			historyTruncationDetected: false
		};
	}
	return {
		lastCheckedAt: row.last_checked_at,
		anchorState: row.anchor_state as AuditIntegrityStatus['anchorState'],
		total: row.total,
		verified: row.verified,
		unverified: row.unverified,
		tamperedCount: row.tampered_count,
		historyMaxRowCount: row.history_max_row_count,
		historyTruncationDetected: row.history_truncation_detected === 1
	};
}

export function runScheduledAuditIntegrityCheck(): AuditIntegrityStatus {
	return recordTaskRunSync(
		'audit_integrity_check',
		() => runInner(),
		(r) => ({ total: r.total, verified: r.verified, tampered: r.tamperedCount, anchor: r.anchorState })
	);
}

function runInner(): AuditIntegrityStatus {
	const r = verifyAuditLogIntegrity();
	const checkedAt = new Date().toISOString();
	stmtUpdate.run(
		checkedAt,
		r.anchor,
		r.total,
		r.verified,
		r.unverified,
		r.tamperedIds.length,
		r.historyMaxRowCount,
		r.historyTruncationDetected ? 1 : 0
	);
	if (r.tamperedIds.length > 0 || r.anchor === 'mismatch' || r.anchor === 'tail-truncated' || r.historyTruncationDetected) {
		log.error('[audit] integrity check FOUND TAMPERING', undefined, {
			tampered: r.tamperedIds.length,
			anchor: r.anchor,
			historyTruncated: r.historyTruncationDetected
		});
	} else {
		log.info('[audit] integrity check passed', { total: r.total, verified: r.verified });
	}
	return getAuditIntegrityStatus();
}
