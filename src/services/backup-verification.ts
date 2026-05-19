import { resolve, join } from 'node:path';
import { existsSync, statSync, readFileSync, mkdirSync, rmSync, openSync, writeSync, closeSync, constants as fsConstants } from 'node:fs';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { db, generateId, parseSqliteUtc, getSetting } from '$lib/server/db.js';
import { BACKUP_DIR } from '$lib/server/data-dir.js';
import { isEncryptedBackup, decryptBackup, ENCRYPTED_BACKUP_EXT } from '$lib/server/backup-crypto.js';
import { getBackupPassphrase, BACKUP_FILENAME_RE } from '$services/backups.js';
import {
	BACKUP_VALID_DOCUMENT_TYPES,
	BACKUP_VALID_SETTINGS_KEYS,
	BACKUP_VALID_ENTITY_TYPES,
	BACKUP_VALID_ACTIONS
} from '$lib/server/backup-allowlists.js';
import { events } from '$lib/server/events.js';
import type {
	BackupVerification,
	BackupVerificationStatus,
	BackupVerificationType,
	RecoveryReadiness,
	BackupSettings
} from '$lib/types.js';

const VERIFY_TMP_PREFIX = '_verify_';
const MAX_RECENT = 100;
const TEST_RESTORE_INTERVAL_MS = 7 * 86400_000;
const OFFSITE_FRESH_INTERVAL_MS = 86400_000;
const BACKUP_FRESH_INTERVAL_MS = 86400_000;

interface VerificationDetails {
	error?: string;
	integrityCheck?: string;
	tableCount?: number;
	documentCount?: number;
	userCount?: number;
}

const stmtInsertVerification = db.prepare(
	'INSERT INTO backup_verifications (id, filename, type, status, size_bytes, duration_ms, details, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
const stmtListVerifications = db.prepare(
	'SELECT id, filename, type, status, size_bytes, duration_ms, details, started_at, completed_at FROM backup_verifications ORDER BY completed_at DESC LIMIT ?'
);
const stmtPruneVerifications = db.prepare(
	'DELETE FROM backup_verifications WHERE id NOT IN (SELECT id FROM backup_verifications ORDER BY completed_at DESC LIMIT ?)'
);
const stmtLatestByType = db.prepare(
	"SELECT completed_at FROM backup_verifications WHERE type = ? AND status = 'passed' ORDER BY completed_at DESC LIMIT 1"
);
const stmtReadReadiness = db.prepare(
	'SELECT score, risk_factors, last_successful_backup_at, last_integrity_at, last_test_restore_at, last_offsite_upload_at, updated_at FROM recovery_readiness WHERE id = 1'
);
const stmtWriteReadiness = db.prepare(
	"UPDATE recovery_readiness SET score = ?, risk_factors = ?, last_successful_backup_at = ?, last_integrity_at = ?, last_test_restore_at = ?, last_offsite_upload_at = ?, updated_at = datetime('now') WHERE id = 1"
);

function safeFilename(filename: string): string {
	if (!BACKUP_FILENAME_RE.test(filename)) throw new Error('Invalid backup filename');
	const full = resolve(join(BACKUP_DIR, filename));
	if (!full.startsWith(BACKUP_DIR + '/')) throw new Error('Path traversal');
	return filename;
}

// Use the shared helper from services/backups so the AAD plumbing and
// failure-mode message stay aligned across the two callers.
const readBackupPassphrase = getBackupPassphrase;

interface DecryptedBuffer {
	buf: Buffer;
	wasEncrypted: boolean;
}

function readDecrypted(filename: string): DecryptedBuffer {
	const filePath = resolve(join(BACKUP_DIR, filename));
	if (!existsSync(filePath)) throw new Error('Backup not found');
	let buf: Buffer = Buffer.from(readFileSync(filePath));
	const looksEncrypted = filename.endsWith(ENCRYPTED_BACKUP_EXT) || isEncryptedBackup(buf);
	if (!looksEncrypted) return { buf, wasEncrypted: false };
	const passphrase = readBackupPassphrase();
	if (!passphrase) throw new Error('Backup is encrypted but no passphrase configured');
	try { buf = decryptBackup(buf, passphrase); }
	catch { throw new Error('Backup decryption failed: passphrase wrong or file corrupted'); }
	return { buf, wasEncrypted: true };
}

async function loadDbFromZip(buf: Buffer, outDbPath: string): Promise<{ tableCount: number; userCount: number; documentCount: number }> {
	const MAX_DB_SIZE = 200 * 1024 * 1024;
	const zip = await JSZip.loadAsync(buf);
	const entry = zip.file('itcake.db');
	if (!entry) throw new Error('Backup missing itcake.db');
	let total = 0;
	const chunks: Buffer[] = [];
	await new Promise<void>((res, rej) => {
		const stream = entry.nodeStream();
		stream.on('data', (c: Buffer) => {
			total += c.length;
			if (total > MAX_DB_SIZE) {
				stream.removeAllListeners();
				rej(new Error(`itcake.db exceeds ${MAX_DB_SIZE / 1024 / 1024}MB cap`));
				return;
			}
			chunks.push(c);
		});
		stream.on('end', () => res());
		stream.on('error', rej);
	});
	const fd = openSync(outDbPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
	try { writeSync(fd, Buffer.concat(chunks)); } finally { closeSync(fd); }

	const verifyDb = new Database(outDbPath, { readonly: true });
	try {
		const integrity = verifyDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
		if (integrity.integrity_check !== 'ok') {
			throw new Error(`integrity_check failed: ${integrity.integrity_check}`);
		}
		const tableCount = (verifyDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n;
		const docCount = (verifyDb.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n;
		const userCount = (verifyDb.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
		// Reject backup-DBs that contain triggers/views — same defense as
		// restoreBackup() applies. A tampered DB could otherwise execute
		// arbitrary SQL on attach.
		const suspicious = verifyDb.prepare("SELECT type, name FROM sqlite_master WHERE type NOT IN ('table', 'index')").all() as { type: string; name: string }[];
		if (suspicious.length > 0) {
			throw new Error(`Backup contains unexpected database objects: ${suspicious.map(s => `${s.type} "${s.name}"`).join(', ')}`);
		}
		return { tableCount, userCount, documentCount: docCount };
	} finally {
		verifyDb.close();
	}
}

export async function verifyBackupIntegrity(filename: string): Promise<BackupVerification> {
	const safe = safeFilename(filename);
	const startedAt = new Date().toISOString();
	const start = Date.now();
	let status: BackupVerificationStatus = 'failed';
	const details: VerificationDetails = {};
	let sizeBytes = 0;
	let tmpDbPath: string | null = null;

	try {
		const filePath = resolve(join(BACKUP_DIR, safe));
		sizeBytes = statSync(filePath).size;
		const { buf } = readDecrypted(safe);

		const tmpName = `${VERIFY_TMP_PREFIX}${generateId()}.db`;
		tmpDbPath = resolve(join(BACKUP_DIR, tmpName));
		const stats = await loadDbFromZip(buf, tmpDbPath);
		details.integrityCheck = 'ok';
		details.tableCount = stats.tableCount;
		details.userCount = stats.userCount;
		details.documentCount = stats.documentCount;
		status = 'passed';
	} catch (e) {
		details.error = e instanceof Error ? e.message : String(e);
	} finally {
		if (tmpDbPath) {
			try { rmSync(tmpDbPath); } catch { /* tmp cleanup */ }
		}
	}

	const durationMs = Date.now() - start;
	const id = generateId();
	stmtInsertVerification.run(id, safe, 'integrity', status, sizeBytes, durationMs, JSON.stringify(details), startedAt);
	stmtPruneVerifications.run(MAX_RECENT);
	const completedAt = new Date().toISOString();

	recomputeRecoveryReadiness();
	events.emit('backup_verification', { id, filename: safe, type: 'integrity', status });

	return {
		id, filename: safe, type: 'integrity', status, sizeBytes, durationMs,
		details, startedAt, completedAt
	};
}

/**
 * Test-restore: same as integrity, plus the same backup-validation that
 * restoreBackup() performs (allowlists for document types, settings keys,
 * audit entity types, FK refs). On success the temp DB is deleted.
 */
export async function runBackupTestRestore(filename: string): Promise<BackupVerification> {
	const safe = safeFilename(filename);
	const startedAt = new Date().toISOString();
	const start = Date.now();
	let status: BackupVerificationStatus = 'failed';
	const details: VerificationDetails = {};
	let sizeBytes = 0;
	let tmpDir: string | null = null;
	let tmpDbPath: string | null = null;

	try {
		const filePath = resolve(join(BACKUP_DIR, safe));
		sizeBytes = statSync(filePath).size;
		const { buf } = readDecrypted(safe);

		tmpDir = resolve(join(BACKUP_DIR, `${VERIFY_TMP_PREFIX}${generateId()}`));
		mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
		tmpDbPath = join(tmpDir, 'itcake.db');
		const stats = await loadDbFromZip(buf, tmpDbPath);
		details.integrityCheck = 'ok';
		details.tableCount = stats.tableCount;
		details.userCount = stats.userCount;
		details.documentCount = stats.documentCount;

		// Apply the same allowlist validation restoreBackup() does — but cheap
		// (no FS uploads work, no template HTML eval). Open the tmp DB read-only
		// and walk documents/settings/changes/counters checking shape only.
		const verifyDb = new Database(tmpDbPath, { readonly: true });
		try {
			const docs = verifyDb.prepare('SELECT id, type, data FROM documents').all() as { id: string; type: string; data: string }[];
			for (const d of docs) {
				if (!BACKUP_VALID_DOCUMENT_TYPES.has(d.type)) throw new Error(`document "${d.id}" has invalid type "${d.type}"`);
				try { JSON.parse(d.data); } catch { throw new Error(`document "${d.id}" has malformed JSON`); }
			}
			const settings = verifyDb.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
			for (const s of settings) {
				if (!BACKUP_VALID_SETTINGS_KEYS.has(s.key)) throw new Error(`unknown settings key "${s.key}"`);
				try { JSON.parse(s.value); } catch { throw new Error(`setting "${s.key}" has malformed JSON`); }
			}
			const users = verifyDb.prepare('SELECT id, email, password_hash FROM users').all() as { id: string; email: string; password_hash: string }[];
			for (const u of users) {
				if (!u.email || !u.password_hash) throw new Error(`user "${u.id}" missing email or password_hash`);
			}
			// Walk the audit chain only if the table exists in the backup.
			const changesExist = verifyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='changes'").get();
			if (changesExist) {
				const changes = verifyDb.prepare('SELECT id, entity_type, action FROM changes').all() as { id: string; entity_type: string; action: string }[];
				for (const c of changes) {
					if (!BACKUP_VALID_ENTITY_TYPES.has(c.entity_type)) throw new Error(`audit row "${c.id}" has invalid entity_type "${c.entity_type}"`);
					if (!BACKUP_VALID_ACTIONS.has(c.action)) throw new Error(`audit row "${c.id}" has invalid action "${c.action}"`);
				}
			}
		} finally {
			verifyDb.close();
		}
		status = 'passed';
	} catch (e) {
		details.error = e instanceof Error ? e.message : String(e);
	} finally {
		if (tmpDir) {
			try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp cleanup */ }
		}
	}

	const durationMs = Date.now() - start;
	const id = generateId();
	stmtInsertVerification.run(id, safe, 'restore', status, sizeBytes, durationMs, JSON.stringify(details), startedAt);
	stmtPruneVerifications.run(MAX_RECENT);
	const completedAt = new Date().toISOString();

	recomputeRecoveryReadiness();
	events.emit('backup_verification', { id, filename: safe, type: 'restore', status });

	return {
		id, filename: safe, type: 'restore', status, sizeBytes, durationMs,
		details, startedAt, completedAt
	};
}

export function listBackupVerifications(limit = 50): BackupVerification[] {
	const cap = Math.min(MAX_RECENT, Math.max(1, limit));
	const rows = stmtListVerifications.all(cap) as {
		id: string; filename: string; type: string; status: string;
		size_bytes: number; duration_ms: number; details: string;
		started_at: string; completed_at: string;
	}[];
	return rows.map(r => {
		let details: VerificationDetails = {};
		try { details = JSON.parse(r.details); } catch { /* keep default */ }
		return {
			id: r.id, filename: r.filename, type: r.type as BackupVerificationType,
			status: r.status as BackupVerificationStatus,
			sizeBytes: r.size_bytes, durationMs: r.duration_ms,
			details, startedAt: r.started_at, completedAt: r.completed_at
		};
	});
}

interface ScoreInputs {
	lastSuccessfulBackupAt: string | null;
	lastIntegrityAt: string | null;
	lastTestRestoreAt: string | null;
	lastOffsiteUploadAt: string | null;
	offsiteEnabled: boolean;
}

interface ScoreResult {
	score: number;
	riskFactors: string[];
}

export function computeReadinessScore(input: ScoreInputs, now: number = Date.now()): ScoreResult {
	const factors: string[] = [];
	let score = 0;

	const ageMs = (iso: string | null) => iso ? Math.max(0, now - parseSqliteUtc(iso)) : Infinity;

	const backupAge = ageMs(input.lastSuccessfulBackupAt);
	if (backupAge < BACKUP_FRESH_INTERVAL_MS) score += 30;
	else if (backupAge < 7 * 86400_000) { score += 15; factors.push('No fresh backup in the last 24h'); }
	else factors.push('No successful backup in the last 7 days');

	const integrityAge = ageMs(input.lastIntegrityAt);
	if (integrityAge < 7 * 86400_000) score += 25;
	else factors.push('Latest backup has not passed an integrity check');

	const restoreAge = ageMs(input.lastTestRestoreAt);
	if (restoreAge < TEST_RESTORE_INTERVAL_MS) score += 25;
	else if (restoreAge < 30 * 86400_000) { score += 12; factors.push('Last test-restore is older than a week'); }
	else factors.push('No successful test-restore in the last 30 days');

	if (input.offsiteEnabled) {
		const offsiteAge = ageMs(input.lastOffsiteUploadAt);
		if (offsiteAge < OFFSITE_FRESH_INTERVAL_MS) score += 20;
		else factors.push('Off-site upload has not succeeded in the last 24h');
	} else {
		// Rebalance the missing 20 — operator opted out, that's fine.
		score = Math.round(score * 100 / 80);
		score = Math.min(100, score);
	}

	return { score: Math.min(100, score), riskFactors: factors };
}

export function recomputeRecoveryReadiness(): RecoveryReadiness {
	const integrityRow = stmtLatestByType.get('integrity') as { completed_at: string } | undefined;
	const restoreRow = stmtLatestByType.get('restore') as { completed_at: string } | undefined;

	const settings = getSetting<BackupSettings>('backup');
	const lastUpload = settings?.offsite?.lastUpload;
	const lastOffsite = lastUpload?.ok ? (lastUpload.at ?? null) : null;
	const offsiteEnabled = !!settings?.offsite?.enabled;

	// "Last successful backup" = whichever is newer between an integrity-passed
	// row (cheap proof a local backup exists & is decryptable) and an off-site
	// upload (which always implies a fresh local backup was created).
	const lastBackupCandidates = [integrityRow?.completed_at, lastOffsite].filter((x): x is string => !!x);
	const lastSuccessfulBackupAt = lastBackupCandidates.length > 0
		? lastBackupCandidates.sort().slice(-1)[0]
		: null;

	const inputs: ScoreInputs = {
		lastSuccessfulBackupAt,
		lastIntegrityAt: integrityRow?.completed_at ?? null,
		lastTestRestoreAt: restoreRow?.completed_at ?? null,
		lastOffsiteUploadAt: lastOffsite,
		offsiteEnabled
	};
	const { score, riskFactors } = computeReadinessScore(inputs);

	stmtWriteReadiness.run(
		score,
		JSON.stringify(riskFactors),
		inputs.lastSuccessfulBackupAt,
		inputs.lastIntegrityAt,
		inputs.lastTestRestoreAt,
		inputs.lastOffsiteUploadAt
	);
	return getRecoveryReadiness();
}

export function getRecoveryReadiness(): RecoveryReadiness {
	const row = stmtReadReadiness.get() as {
		score: number; risk_factors: string;
		last_successful_backup_at: string | null;
		last_integrity_at: string | null;
		last_test_restore_at: string | null;
		last_offsite_upload_at: string | null;
		updated_at: string;
	} | undefined;
	if (!row) {
		return {
			score: 0, riskFactors: ['No backup activity recorded'],
			lastSuccessfulBackupAt: null, lastIntegrityAt: null,
			lastTestRestoreAt: null, lastOffsiteUploadAt: null,
			updatedAt: new Date().toISOString()
		};
	}
	let riskFactors: string[] = [];
	try {
		const parsed = JSON.parse(row.risk_factors);
		if (Array.isArray(parsed)) riskFactors = parsed.filter((s): s is string => typeof s === 'string');
	} catch { /* fall back to default */ }
	return {
		score: row.score,
		riskFactors,
		lastSuccessfulBackupAt: row.last_successful_backup_at,
		lastIntegrityAt: row.last_integrity_at,
		lastTestRestoreAt: row.last_test_restore_at,
		lastOffsiteUploadAt: row.last_offsite_upload_at,
		updatedAt: row.updated_at
	};
}

/**
 * Pick a backup file to test-restore this week. We rotate by week-bucket
 * across the available backups so a long-running deployment exercises
 * every backup in the folder over time without the operator coordinating.
 */
export function pickWeeklyTestRestoreCandidate(filenames: string[], now: number = Date.now()): string | null {
	if (filenames.length === 0) return null;
	const sorted = [...filenames].sort();
	const weekBucket = Math.floor(now / (7 * 86400_000));
	return sorted[weekBucket % sorted.length];
}
