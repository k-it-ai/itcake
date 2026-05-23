/**
 * Operator visibility for long-running background tasks.
 *
 * Each invocation of a wrapped task gets one row in `task_runs`:
 *   - inserted with status='running' at start (so the dashboard can
 *     show in-flight work, including across a server restart that left
 *     a row stranded — those are stuck-running and inspected at boot).
 *   - updated to status='ok'|'error' with finished_at + details/error.
 *
 * Kept generic on purpose — every callsite passes its own `kind` and
 * its own JSON-serialisable details. Old rows pruned at 90 days by
 * the daily tick in hooks.server.ts.
 */
import { db } from './db.js';
import { log } from './log.js';
import { stripSecrets } from './ai/compaction.js';
import { truncateChars } from './sanitize.js';

db.exec(`
	CREATE TABLE IF NOT EXISTS task_runs (
		id INTEGER PRIMARY KEY,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
		started_at TEXT NOT NULL,
		finished_at TEXT,
		details TEXT,
		error TEXT
	);
	CREATE INDEX IF NOT EXISTS task_runs_started_at ON task_runs(started_at DESC);
	CREATE INDEX IF NOT EXISTS task_runs_kind_started ON task_runs(kind, started_at DESC);
`);

// Stuck-running rows from a server restart can never finish; surface them
// as errors so the dashboard doesn't show a perpetual spinner.
db.prepare(
	"UPDATE task_runs SET status='error', error='process restarted while task was running', finished_at = datetime('now') WHERE status='running'"
).run();

const stmtInsert = db.prepare(
	"INSERT INTO task_runs (kind, status, started_at) VALUES (?, 'running', datetime('now'))"
);
const stmtFinishOk = db.prepare(
	"UPDATE task_runs SET status='ok', finished_at = datetime('now'), details = ? WHERE id = ?"
);
const stmtFinishErr = db.prepare(
	"UPDATE task_runs SET status='error', finished_at = datetime('now'), error = ? WHERE id = ?"
);
const stmtRecent = db.prepare(
	'SELECT id, kind, status, started_at, finished_at, details, error FROM task_runs ORDER BY id DESC LIMIT ?'
);
const stmtPrune = db.prepare("DELETE FROM task_runs WHERE started_at < datetime('now', '-' || ? || ' days')");

export interface TaskRun {
	id: number;
	kind: string;
	status: 'running' | 'ok' | 'error';
	startedAt: string;
	finishedAt: string | null;
	details: unknown;
	error: string | null;
}

export async function recordTaskRun<T>(
	kind: string,
	fn: () => Promise<T> | T,
	pickDetails?: (result: T) => unknown
): Promise<T> {
	const { lastInsertRowid } = stmtInsert.run(kind);
	const id = Number(lastInsertRowid);
	try {
		const result = await fn();
		const details = pickDetails ? pickDetails(result) : undefined;
		stmtFinishOk.run(details === undefined ? null : JSON.stringify(details), id);
		return result;
	} catch (e) {
		// Strip token-shaped secrets before DB storage — task_runs.error is
		// surfaced via GET /api/tasks AND included in local backups + audit
		// exports. An exception thrown by createBackup / restoreBackup /
		// rotateBackupPassphrase can carry passphrase fragments or ciphertext
		// in its message; without redaction those land in the backup zip.
		const msg = stripSecrets(e instanceof Error ? e.message : String(e));
		stmtFinishErr.run(truncateChars(msg, 2000), id);
		log.warn('[task-run] failed', { kind, error: msg });
		throw e;
	}
}

export function recordTaskRunSync<T>(
	kind: string,
	fn: () => T,
	pickDetails?: (result: T) => unknown
): T {
	const { lastInsertRowid } = stmtInsert.run(kind);
	const id = Number(lastInsertRowid);
	try {
		const result = fn();
		const details = pickDetails ? pickDetails(result) : undefined;
		stmtFinishOk.run(details === undefined ? null : JSON.stringify(details), id);
		return result;
	} catch (e) {
		const msg = stripSecrets(e instanceof Error ? e.message : String(e));
		stmtFinishErr.run(truncateChars(msg, 2000), id);
		log.warn('[task-run] failed', { kind, error: msg });
		throw e;
	}
}

export function getRecentTaskRuns(limit = 100): TaskRun[] {
	const rows = stmtRecent.all(Math.max(1, Math.min(500, limit))) as Array<{
		id: number; kind: string; status: string;
		started_at: string; finished_at: string | null;
		details: string | null; error: string | null;
	}>;
	return rows.map(r => ({
		id: r.id, kind: r.kind, status: r.status as TaskRun['status'],
		startedAt: r.started_at, finishedAt: r.finished_at,
		details: r.details ? safeParse(r.details) : null,
		error: r.error
	}));
}

function safeParse(s: string): unknown {
	try { return JSON.parse(s); } catch { return s; }
}

export function pruneOldTaskRuns(retentionDays = 90): number {
	const r = stmtPrune.run(Math.max(1, retentionDays));
	return r.changes ?? 0;
}
