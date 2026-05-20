import { db } from '$lib/server/db.js';
import Database from 'better-sqlite3';
import { resolve, join, basename, sep } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync, lstatSync, unlinkSync, readFileSync, rmSync, renameSync, openSync, closeSync, writeSync, chmodSync, constants as fsConstants } from 'node:fs';
import JSZip from 'jszip';
import { BACKUP_DIR, UPLOAD_DIR } from '$lib/server/data-dir.js';
import { verifyMagicBytes } from '$lib/server/file-validation.js';
import { validateTemplateSafety, sanitizeCss } from '$lib/server/template-renderer.js';
import { sanitizeRichText } from '$lib/server/sanitize.js';
import { events } from '$lib/server/events.js';
import { encryptField, decryptField, isEncryptedField } from '$lib/server/field-crypto.js';
import { encryptBackup, decryptBackup, isEncryptedBackup, ENCRYPTED_BACKUP_EXT } from '$lib/server/backup-crypto.js';
import { recomputeAuditAnchor } from '$lib/server/changes.js';
import { recordTaskRun } from '$lib/server/task-runs.js';
import {
	BACKUP_VALID_DOCUMENT_TYPES,
	BACKUP_VALID_SETTINGS_KEYS,
	BACKUP_VALID_ENTITY_TYPES,
	BACKUP_VALID_ACTIONS,
	BACKUP_VALID_COUNTER_KEYS
} from '$lib/server/backup-allowlists.js';
import { BUILT_IN_TEMPLATES } from '$services/templates.js';

const DECOMPRESSED_TOTAL_CAP = 600 * 1024 * 1024;
const DECOMPRESSED_RATIO_CAP = 100;

function enforceZipBombCaps(zip: JSZip, compressedSize: number): void {
	let uncompressedTotal = 0;
	let metadataMissing = false;
	zip.forEach((_relativePath, entry) => {
		if (entry.dir) return;
		const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
		if (!data || typeof data.uncompressedSize !== 'number') {
			metadataMissing = true;
			return;
		}
		uncompressedTotal += data.uncompressedSize;
	});
	if (metadataMissing) {
		throw new Error('Backup rejected: central-directory metadata missing uncompressed sizes (possible bomb concealment)');
	}
	if (uncompressedTotal > DECOMPRESSED_TOTAL_CAP) {
		throw new Error(`Backup expands to ${Math.round(uncompressedTotal / 1024 / 1024)}MB which exceeds the ${DECOMPRESSED_TOTAL_CAP / 1024 / 1024}MB cap; refusing to decompress`);
	}
	if (compressedSize > 0 && uncompressedTotal / compressedSize > DECOMPRESSED_RATIO_CAP) {
		const ratio = Math.round(uncompressedTotal / compressedSize);
		throw new Error(`Backup compression ratio ${ratio}:1 exceeds ${DECOMPRESSED_RATIO_CAP}:1 zip-bomb threshold; refusing to decompress`);
	}
}

async function streamExtractCapped(file: JSZip.JSZipObject, cap: number, label: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const stream = file.nodeStream();
		let total = 0;
		const chunks: Buffer[] = [];
		stream.on('data', (chunk: Buffer) => {
			total += chunk.length;
			if (total > cap) {
				stream.removeAllListeners();
				reject(new Error(`${label} exceeds ${Math.round(cap / 1024 / 1024)}MB limit`));
				return;
			}
			chunks.push(chunk);
		});
		stream.on('end', () => resolve(Buffer.concat(chunks)));
		stream.on('error', (err: Error) => reject(err));
	});
}

function rejectSuspiciousDbObjects(backupDb: InstanceType<typeof Database>): void {
	const suspicious = backupDb.prepare("SELECT type, name FROM sqlite_master WHERE type NOT IN ('table', 'index')").all() as { type: string; name: string }[];
	if (suspicious.length > 0) {
		backupDb.close();
		throw new Error(`Invalid backup: contains unexpected database objects: ${suspicious.map(s => `${s.type} "${s.name}"`).join(', ')}`);
	}
}

export interface BackupInfo {
	filename: string;
	size: number;
	createdAt: string;
}

function ensureBackupDir(): void {
	if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
	// Tighten on existing dirs too (no-op when already 0o700; corrects 0o755).
	try { chmodSync(BACKUP_DIR, 0o700); } catch { /* best effort on platforms without chmod */ }
}

const PRE_RESTORE_RETENTION_MS = 14 * 86400_000;

function cleanupStaleTempFiles(): void {
	try {
		if (!existsSync(BACKUP_DIR)) return;
		const now = Date.now();
		for (const entry of readdirSync(BACKUP_DIR)) {
			const fullPath = resolve(join(BACKUP_DIR, entry));
			if (
				entry.startsWith('_restore_') ||
				entry.startsWith('_tmp_') ||
				entry.startsWith('_old_uploads_') ||
				entry.startsWith('_preview_')
			) {
				try { rmSync(fullPath, { recursive: true }); } catch { /* best effort */ }
			} else if (entry.startsWith('_pre_restore_')) {
				// Pre-restore artifacts: keep recent ones for rollback, prune older.
				try {
					const stat = statSync(fullPath);
					if (now - stat.mtimeMs > PRE_RESTORE_RETENTION_MS) {
						rmSync(fullPath, { recursive: true });
					}
				} catch { /* best effort */ }
			}
		}
	} catch { /* non-critical */ }
}

cleanupStaleTempFiles();

let backupInProgress = false;

export class BackupInProgressError extends Error {
	constructor() {
		super('A backup is already in progress');
		this.name = 'BackupInProgressError';
	}
}

export async function withBackupLock<T>(fn: () => Promise<T>): Promise<T> {
	if (backupInProgress) throw new BackupInProgressError();
	backupInProgress = true;
	try {
		return await fn();
	} finally {
		backupInProgress = false;
	}
}

export const BACKUP_FILENAME_RE = /^backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip(\.enc)?$/;

function sanitizeFilename(filename: string): string | null {
	const safe = basename(filename);
	if (!safe || safe !== filename || safe.includes('..')) return null;
	if (!BACKUP_FILENAME_RE.test(safe)) return null;
	const full = resolve(join(BACKUP_DIR, safe));
	if (!full.startsWith(BACKUP_DIR + sep)) return null;
	return safe;
}

export class BackupPassphraseUnreadableError extends Error {
	constructor() {
		super('Backup passphrase is configured but could not be decrypted (SESSION_SECRET changed or ciphertext corrupted). Refusing to fall through to a plaintext backup.');
		this.name = 'BackupPassphraseUnreadableError';
	}
}

// Reads the raw settings row + decrypts explicitly + throws on read failure
// (rather than falling back to '', which would silently downgrade the backup
// to plaintext). Accepts both legacy enc2 and current enc3 (AAD-bound).
export function getBackupPassphrase(): string {
	const row = db.prepare("SELECT value FROM settings WHERE key = 'backup'").get() as { value: string } | undefined;
	if (!row) return '';
	let parsed: { encryptionPassphrase?: unknown };
	try { parsed = JSON.parse(row.value); } catch { return ''; }
	const raw = parsed.encryptionPassphrase;
	if (typeof raw !== 'string' || !raw) return '';
	if (!isEncryptedField(raw)) return raw;
	const decrypted = raw.startsWith('enc3:')
		? decryptField(raw, 'backup.encryptionPassphrase:1')
		: decryptField(raw);
	if (!decrypted) throw new BackupPassphraseUnreadableError();
	return decrypted;
}

interface CreateBackupOptions {
	filenamePrefix?: string;
	// `''` forces unencrypted output — used by the disaster-recovery
	// pre-restore-snapshot path when the configured passphrase ciphertext
	// is unreadable (SESSION_SECRET rotation).
	forcePassphrase?: string;
}

export async function createBackup(opts: CreateBackupOptions = {}): Promise<BackupInfo> {
	return recordTaskRun(
		'backup_create',
		() => createBackupInner(opts),
		(r) => ({ filename: r.filename, size: r.size })
	);
}

async function createBackupInner(opts: CreateBackupOptions = {}): Promise<BackupInfo> {
	ensureBackupDir();

	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const prefix = opts.filenamePrefix ?? 'backup-';
	const filename = `${prefix}${timestamp}.zip`;

	const tmpDbPath = resolve(join(BACKUP_DIR, `_tmp_${timestamp}.db`));
	try {
		await db.backup(tmpDbPath);
		// db.backup writes with the better-sqlite3 default mode (subject to umask
		// — typically 0o644). The temp DB contains every secret in plaintext at
		// rest until the encrypted ZIP is produced and `unlinkSync` runs in the
		// finally block; force 0o600 so a non-root local user cannot read it
		// during that window. Best-effort on platforms where chmod is a no-op.
		try { chmodSync(tmpDbPath, 0o600); } catch (e) { console.warn('[backup] chmod tmp db failed:', e instanceof Error ? e.message : e); }

		const tmpDb = new Database(tmpDbPath);
		try {
			tmpDb.exec('DELETE FROM sessions');

			const emailsRow = tmpDb.prepare("SELECT value FROM settings WHERE key = 'emails'").get() as { value: string } | undefined;
			if (emailsRow) {
				const emails = JSON.parse(emailsRow.value);
				if (emails.smtp?.pass && typeof emails.smtp.pass === 'string' && !isEncryptedField(emails.smtp.pass)) {
					emails.smtp.pass = encryptField(emails.smtp.pass, 'emails.smtp.pass:1');
					tmpDb.prepare("UPDATE settings SET value = ? WHERE key = 'emails'").run(JSON.stringify(emails));
				}
			}
			const uptimeRow = tmpDb.prepare("SELECT value FROM settings WHERE key = 'uptime'").get() as { value: string } | undefined;
			if (uptimeRow) {
				const uptime = JSON.parse(uptimeRow.value);
				if (uptime.telegram?.botToken && typeof uptime.telegram.botToken === 'string' && !isEncryptedField(uptime.telegram.botToken)) {
					uptime.telegram.botToken = encryptField(uptime.telegram.botToken, 'uptime.telegram.botToken:1');
					tmpDb.prepare("UPDATE settings SET value = ? WHERE key = 'uptime'").run(JSON.stringify(uptime));
				}
			}
			// Strip the passphrase ciphertext so the backup isn't self-decryptable.
			const backupRow = tmpDb.prepare("SELECT value FROM settings WHERE key = 'backup'").get() as { value: string } | undefined;
			if (backupRow) {
				const backup = JSON.parse(backupRow.value);
				if (backup.encryptionPassphrase) {
					backup.encryptionPassphrase = '';
					tmpDb.prepare("UPDATE settings SET value = ? WHERE key = 'backup'").run(JSON.stringify(backup));
				}
			}
		} finally {
			tmpDb.close();
		}

		const zip = new JSZip();

		const dbData = readFileSync(tmpDbPath);
		zip.file('itcake.db', dbData);

		if (existsSync(UPLOAD_DIR)) {
			const addDirToZip = (dir: string, zipPrefix: string) => {
				const entries = readdirSync(dir);
				for (const entry of entries) {
					const entryPath = resolve(join(dir, entry));
					if (!entryPath.startsWith(UPLOAD_DIR + sep)) continue;
					let lst;
					try { lst = lstatSync(entryPath); } catch { continue; }
					if (lst.isSymbolicLink()) continue;
					if (lst.isFile()) {
						zip.file(`${zipPrefix}/${entry}`, readFileSync(entryPath));
					} else if (lst.isDirectory()) {
						addDirToZip(entryPath, `${zipPrefix}/${entry}`);
					}
				}
			};
			addDirToZip(UPLOAD_DIR, 'uploads');
		}

		const manifest = {
			version: '1.0',
			timestamp: now.toISOString(),
			nodeVersion: process.version,
			dbPath: 'itcake.db'
		};
		zip.file('manifest.json', JSON.stringify(manifest, null, 2));

		const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

		const passphrase = opts.forcePassphrase !== undefined ? opts.forcePassphrase : getBackupPassphrase();
		const encrypted = !!passphrase;
		const finalBuffer = encrypted ? encryptBackup(zipBuffer, passphrase) : zipBuffer;
		const finalName = encrypted ? filename + '.enc' : filename;

		const outputPath = resolve(join(BACKUP_DIR, finalName));
		// 0o600 + O_NOFOLLOW — mandatory for the G1-EDGE unencrypted-fallback
		// artifact (entire DB plaintext); defense-in-depth for .zip.enc.
		// O_TRUNC (not O_EXCL) so two backups in the same second don't collide.
		// BACKUP_DIR itself is 0o700 service-owned, so external write attacks
		// are bounded to the service user. Pre-existing-file mode is preserved
		// by `chmodSync` post-write.
		const ofd = openSync(outputPath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
		try { writeSync(ofd, finalBuffer); } finally { closeSync(ofd); }
		try { chmodSync(outputPath, 0o600); } catch { /* best effort */ }

		const stat = statSync(outputPath);
		return {
			filename: finalName,
			size: stat.size,
			createdAt: now.toISOString()
		};
	} finally {
		try { unlinkSync(tmpDbPath); } catch (e) { console.warn('Cleanup failed:', e instanceof Error ? e.message : e); }
	}
}

export function getBackups(): BackupInfo[] {
	ensureBackupDir();

	const files = readdirSync(BACKUP_DIR);
	return files
		.filter((f) => BACKUP_FILENAME_RE.test(f))
		.map((f) => {
			const filePath = join(BACKUP_DIR, f);
			const stat = statSync(filePath);
			return {
				filename: f,
				size: stat.size,
				createdAt: stat.mtime.toISOString()
			};
		})
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getBackupPath(filename: string): string | null {
	const safe = sanitizeFilename(filename);
	if (!safe) return null;
	const filePath = resolve(join(BACKUP_DIR, safe));
	if (!existsSync(filePath)) return null;
	return filePath;
}

export function deleteBackup(filename: string): boolean {
	const safe = sanitizeFilename(filename);
	if (!safe) return false;
	const filePath = resolve(join(BACKUP_DIR, safe));
	if (!existsSync(filePath)) return false;
	unlinkSync(filePath);
	return true;
}

export interface PassphraseRotationResult {
	rotated: { filename: string }[];
	skippedPlaintext: { filename: string }[];
	failed: { filename: string; reason: string }[];
}

/**
 * Re-encrypts every `.zip.enc` in BACKUP_DIR from oldPassphrase to
 * newPassphrase, one file at a time. Plaintext `.zip` backups are
 * skipped (they have no passphrase to rotate). Atomic per file: writes
 * to `<name>.rotating` then renames over the original; on failure the
 * original is left untouched and the temp removed.
 *
 * The caller is responsible for updating settings.backup.encryptionPassphrase
 * AFTER this returns — that way a partial rotation followed by a server
 * crash still leaves the operator able to read every file in BACKUP_DIR
 * with either the old or the new passphrase (depending on which side
 * each file is on).
 */
export function rotateBackupPassphrase(
	oldPassphrase: string,
	newPassphrase: string
): PassphraseRotationResult {
	if (!oldPassphrase) throw new Error('oldPassphrase required');
	if (!newPassphrase) throw new Error('newPassphrase required');
	if (oldPassphrase === newPassphrase) throw new Error('newPassphrase must differ from oldPassphrase');
	// recordTaskRun is async-or-sync; we want a sync return shape, so unwrap.
	// Wrapping happens at the API boundary.

	const result: PassphraseRotationResult = { rotated: [], skippedPlaintext: [], failed: [] };
	const files = getBackups();

	for (const b of files) {
		const safe = sanitizeFilename(b.filename);
		if (!safe) continue;
		const full = resolve(join(BACKUP_DIR, safe));
		let blob: Buffer;
		try { blob = readFileSync(full); }
		catch (e) { result.failed.push({ filename: safe, reason: e instanceof Error ? e.message : String(e) }); continue; }

		if (!isEncryptedBackup(blob)) {
			result.skippedPlaintext.push({ filename: safe });
			continue;
		}

		let plain: Buffer;
		try { plain = decryptBackup(blob, oldPassphrase); }
		catch (e) { result.failed.push({ filename: safe, reason: e instanceof Error ? e.message : 'decrypt failed' }); continue; }

		let reencrypted: Buffer;
		try { reencrypted = encryptBackup(plain, newPassphrase); }
		catch (e) { result.failed.push({ filename: safe, reason: e instanceof Error ? e.message : 'encrypt failed' }); continue; }

		const tmpPath = `${full}.rotating`;
		try {
			const fd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
			try { writeSync(fd, reencrypted); } finally { closeSync(fd); }
			renameSync(tmpPath, full);
			result.rotated.push({ filename: safe });
		} catch (e) {
			try { unlinkSync(tmpPath); } catch { /* best effort */ }
			result.failed.push({ filename: safe, reason: e instanceof Error ? e.message : 'write failed' });
		}
	}
	return result;
}

// Local-backup retention: at least N most-recent files survive AND any
// backup younger than retentionDays survives. Both conditions together —
// so the operator never ends up with zero backups even if the last
// successful one is older than the day cap.
export function pruneOldLocalBackups(opts: { keepMin?: number; retentionDays?: number } = {}): number {
	const keepMin = Math.max(1, opts.keepMin ?? 7);
	const retentionDays = Math.max(1, opts.retentionDays ?? 30);
	const cutoffMs = Date.now() - retentionDays * 86400_000;
	const backups = getBackups(); // sorted DESC by createdAt
	if (backups.length <= keepMin) return 0;
	let removed = 0;
	for (let i = keepMin; i < backups.length; i++) {
		const b = backups[i];
		const createdMs = Date.parse(b.createdAt);
		if (Number.isFinite(createdMs) && createdMs >= cutoffMs) continue;
		if (deleteBackup(b.filename)) removed++;
	}
	return removed;
}

/** Must be called while backup_db is ATTACHed. */
function validateBackupData(): void {
	const VALID_TYPES = BACKUP_VALID_DOCUMENT_TYPES;
	const MAX_DOC_JSON_SIZE = 5 * 1024 * 1024;
	const VALID_SETTINGS_KEYS = BACKUP_VALID_SETTINGS_KEYS;
	const BUILT_IN_TEMPLATE_IDS = new Set(BUILT_IN_TEMPLATES);

	// Strip any backup.encryptionPassphrase the source ZIP might carry. A
	// tampered backup could plant a passphrase the attacker knows; subsequent
	// off-site uploads would then be decryptable by them. createBackup elides
	// the passphrase at backup time, but a hostile backup needs to be elided
	// at restore time too.
	const backupRow = db.prepare("SELECT value FROM backup_db.settings WHERE key = 'backup'").get() as { value: string } | undefined;
	if (backupRow) {
		try {
			const parsed = JSON.parse(backupRow.value) as Record<string, unknown>;
			if (parsed.encryptionPassphrase) {
				parsed.encryptionPassphrase = '';
				db.prepare("UPDATE backup_db.settings SET value = ? WHERE key = 'backup'").run(JSON.stringify(parsed));
				console.warn('[backup] restore: stripped backup.encryptionPassphrase from source ZIP (defence against tampered-backup passphrase plant)');
			}
		} catch { /* corrupt JSON — let downstream rejection handle it */ }
	}

	const docs = db.prepare('SELECT id, type, data FROM backup_db.documents').all() as { id: string; type: string; data: string }[];
	for (const doc of docs) {
		if (!VALID_TYPES.has(doc.type)) {
			throw new Error(`Invalid backup: document "${doc.id}" has invalid type "${doc.type}"`);
		}
		if (doc.data.length > MAX_DOC_JSON_SIZE) {
			throw new Error(`Invalid backup: document "${doc.id}" exceeds ${MAX_DOC_JSON_SIZE / 1024 / 1024}MB`);
		}
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(doc.data);
		} catch {
			throw new Error(`Invalid backup: document "${doc.id}" contains malformed JSON`);
		}

		if (doc.type === 'template') {
			if (parsed.builtIn === true && !BUILT_IN_TEMPLATE_IDS.has(doc.id)) {
				throw new Error(`Invalid backup: template "${doc.id}" claims builtIn but is not a known built-in template`);
			}
			{
				if (typeof parsed.html === 'string') {
					try {
						validateTemplateSafety(parsed.html, doc.id);
					} catch (e) {
						throw new Error(`Invalid backup: template "${doc.id}" contains unsafe EJS: ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				if (typeof parsed.css === 'string') {
					parsed.css = sanitizeCss(parsed.css);
					doc.data = JSON.stringify(parsed);
					db.prepare('UPDATE backup_db.documents SET data = ? WHERE id = ?').run(doc.data, doc.id);
				}
			}
		}
	}

	for (const doc of docs) {
		if (doc.type !== 'ticket') continue;
		const parsed = JSON.parse(doc.data) as Record<string, unknown>;
		if (typeof parsed.description === 'string' && parsed.description) {
			parsed.description = sanitizeRichText(parsed.description);
			doc.data = JSON.stringify(parsed);
			db.prepare('UPDATE backup_db.documents SET data = ? WHERE id = ?').run(doc.data, doc.id);
		}
	}

	const settings = db.prepare('SELECT key, value FROM backup_db.settings').all() as { key: string; value: string }[];
	for (const s of settings) {
		if (!VALID_SETTINGS_KEYS.has(s.key)) {
			throw new Error(`Invalid backup: unknown settings key "${s.key}"`);
		}
		try {
			JSON.parse(s.value);
		} catch {
			throw new Error(`Invalid backup: setting "${s.key}" contains malformed JSON`);
		}
	}

	const users = db.prepare('SELECT id, email, password_hash FROM backup_db.users').all() as { id: string; email: string; password_hash: string }[];
	for (const user of users) {
		if (!user.email || !user.password_hash) {
			throw new Error(`Invalid backup: user "${user.id}" missing email or password_hash`);
		}
	}

	const clientIds = new Set(
		docs.filter(d => d.type === 'client').map(d => d.id)
	);
	for (const doc of docs) {
		if (doc.type !== 'invoice' && doc.type !== 'proposal' && doc.type !== 'ticket') continue;
		const parsed = JSON.parse(doc.data) as Record<string, unknown>;
		const clientId = parsed.clientId;
		if (typeof clientId === 'string' && clientId && !clientIds.has(clientId)) {
			throw new Error(`Invalid backup: ${doc.type} "${doc.id}" references non-existent client "${clientId}"`);
		}
	}

	const invoiceIds = new Set(
		docs.filter(d => d.type === 'invoice').map(d => d.id)
	);
	for (const doc of docs) {
		if (doc.type !== 'invoice') continue;
		const parsed = JSON.parse(doc.data) as Record<string, unknown>;
		const linkedId = parsed.linkedInvoiceId;
		if (typeof linkedId === 'string' && linkedId && !invoiceIds.has(linkedId)) {
			throw new Error(`Invalid backup: credit note "${doc.id}" references non-existent invoice "${linkedId}"`);
		}
	}

	const VALID_ENTITY_TYPES = BACKUP_VALID_ENTITY_TYPES;
	const VALID_ACTIONS = BACKUP_VALID_ACTIONS;
	const userIds = new Set(users.map(u => u.id));
	userIds.add('system');

	const changesExist = db.prepare("SELECT name FROM backup_db.sqlite_master WHERE type='table' AND name='changes'").get();
	if (changesExist) {
		const changes = db.prepare('SELECT id, entity_type, entity_id, action, diff, user_id FROM backup_db.changes').all() as {
			id: string; entity_type: string; entity_id: string; action: string; diff: string; user_id: string;
		}[];
		for (const c of changes) {
			if (!VALID_ENTITY_TYPES.has(c.entity_type)) {
				throw new Error(`Invalid backup: audit entry "${c.id}" has invalid entity_type "${c.entity_type}"`);
			}
			if (!VALID_ACTIONS.has(c.action)) {
				throw new Error(`Invalid backup: audit entry "${c.id}" has invalid action "${c.action}"`);
			}
			if (!userIds.has(c.user_id)) {
				throw new Error(`Invalid backup: audit entry "${c.id}" references non-existent user "${c.user_id}"`);
			}
			if (c.diff) {
				try { JSON.parse(c.diff); } catch {
					throw new Error(`Invalid backup: audit entry "${c.id}" contains malformed diff JSON`);
				}
			}
		}
	}

	const VALID_COUNTER_KEYS = BACKUP_VALID_COUNTER_KEYS;
	const countersExist = db.prepare("SELECT name FROM backup_db.sqlite_master WHERE type='table' AND name='counters'").get();
	if (countersExist) {
		const counters = db.prepare('SELECT key, value FROM backup_db.counters').all() as { key: string; value: number }[];
		for (const c of counters) {
			if (!VALID_COUNTER_KEYS.has(c.key)) {
				throw new Error(`Invalid backup: unknown counter key "${c.key}"`);
			}
			if (!Number.isInteger(c.value) || c.value < 0 || c.value > 9_999_999) {
				throw new Error(`Invalid backup: counter "${c.key}" has invalid value ${c.value}`);
			}
		}

		// Counters must be consistent with the document set they sequence;
		// otherwise the next auto-generated documentId post-restore collides
		// with an existing row. Map each counter to its document type, then
		// require counter >= max(document_count, max_trailing_digit_in_documentId).
		const counterToDocType: Record<string, string> = {
			invoice_global: 'invoice',
			proposal_global: 'proposal',
			client_global: 'client',
			ticket_global: 'ticket'
		};
		const counterByKey = new Map(counters.map(c => [c.key, c.value]));
		for (const [key, docType] of Object.entries(counterToDocType)) {
			const cv = counterByKey.get(key);
			if (cv === undefined) continue;
			const countRow = db.prepare("SELECT COUNT(*) AS n FROM backup_db.documents WHERE type = ?").get(docType) as { n: number };
			const docCount = countRow.n;
			const idRows = db.prepare("SELECT json_extract(data, '$.documentId') AS docId FROM backup_db.documents WHERE type = ?").all(docType) as { docId: string | null }[];
			let maxTrailing = 0;
			for (const r of idRows) {
				if (typeof r.docId !== 'string') continue;
				const m = r.docId.match(/(\d+)\D*$/);
				if (m) {
					const n = parseInt(m[1], 10);
					if (Number.isFinite(n) && n > maxTrailing) maxTrailing = n;
				}
			}
			const needed = Math.max(docCount, maxTrailing);
			if (cv < needed) {
				throw new Error(`Invalid backup: counter "${key}" value ${cv} is lower than the highest existing ${docType} (max=${needed}); next auto-numbered ${docType} would collide. Refusing restore.`);
			}
		}
	}
}

export async function restoreBackup(filename: string): Promise<void> {
	return recordTaskRun('backup_restore', () => restoreBackupInner(filename), () => ({ filename }));
}

async function restoreBackupInner(filename: string): Promise<void> {
	const safe = sanitizeFilename(filename);
	if (!safe) throw new Error('Invalid backup filename');
	const filePath = resolve(join(BACKUP_DIR, safe));
	if (!existsSync(filePath)) throw new Error('Backup not found');

	const MAX_ZIP_SIZE = 200 * 1024 * 1024;
	const zipStat = statSync(filePath);
	if (zipStat.size > MAX_ZIP_SIZE) throw new Error('Backup file too large (max 200MB compressed)');

	let preRestoreSnapshot: BackupInfo | null = null;
	try {
		preRestoreSnapshot = await createBackup({ filenamePrefix: '_pre_restore_' });
		console.info(`[backup] Pre-restore snapshot: ${preRestoreSnapshot.filename} (${Math.round(preRestoreSnapshot.size / 1024)} KB)`);
	} catch (e) {
		if (e instanceof BackupPassphraseUnreadableError) {
			console.warn('[backup] Pre-restore snapshot: configured passphrase unreadable (likely SESSION_SECRET rotation). Producing an UNENCRYPTED rollback artifact.');
			try {
				preRestoreSnapshot = await createBackup({ filenamePrefix: '_pre_restore_unencrypted_', forcePassphrase: '' });
				console.info(`[backup] Unencrypted pre-restore snapshot: ${preRestoreSnapshot.filename} (${Math.round(preRestoreSnapshot.size / 1024)} KB) — keep this file out of long-term storage.`);
			} catch (e2) {
				throw new Error(`Pre-restore snapshot failed (unencrypted fallback also failed); refusing to mutate DB: ${e2 instanceof Error ? e2.message : String(e2)}`);
			}
		} else {
			throw new Error(`Pre-restore snapshot failed; refusing to mutate DB: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	let zipData: Buffer = Buffer.from(readFileSync(filePath));

	if (safe.endsWith(ENCRYPTED_BACKUP_EXT) || isEncryptedBackup(zipData)) {
		const passphrase = getBackupPassphrase();
		if (!passphrase) throw new Error('This backup is encrypted but no passphrase is configured in Settings');
		try {
			zipData = decryptBackup(zipData, passphrase);
		} catch {
			throw new Error('Backup decryption failed: passphrase wrong or file corrupted');
		}
	}

	const zip = await JSZip.loadAsync(zipData);
	enforceZipBombCaps(zip, zipStat.size);

	const manifestFile = zip.file('manifest.json');
	if (!manifestFile) throw new Error('Invalid backup: missing manifest.json');
	const manifestStr = await manifestFile.async('string');
	if (manifestStr.length > 10_000) throw new Error('Invalid backup: manifest.json too large');
	const manifest = JSON.parse(manifestStr);
	if (!manifest.version || !manifest.dbPath) throw new Error('Invalid backup: bad manifest');
	if (manifest.dbPath !== 'itcake.db') throw new Error('Invalid backup: unexpected database path');

	const dbFile = zip.file(manifest.dbPath);
	if (!dbFile) throw new Error('Invalid backup: missing database file');
	const MAX_DB_SIZE = 100 * 1024 * 1024;
	const dbBuffer = await streamExtractCapped(dbFile, MAX_DB_SIZE, 'database file');
	const tmpDbPath = resolve(join(BACKUP_DIR, `_restore_${Date.now()}.db`));

	try {
		// Plaintext DB on disk for the restore window — must be 0o600 + O_NOFOLLOW.
		const fd = openSync(tmpDbPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
		try { writeSync(fd, dbBuffer); } finally { closeSync(fd); }

		const backupDb = new Database(tmpDbPath, { readonly: true });
		const tables = backupDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
		const tableNames = tables.map(t => t.name);
		const requiredTables = ['documents', 'settings', 'users', 'counters'];
		for (const t of requiredTables) {
			if (!tableNames.includes(t)) {
				backupDb.close();
				throw new Error(`Invalid backup: missing table "${t}"`);
			}
		}
		rejectSuspiciousDbObjects(backupDb);
		backupDb.close();

		const uploadEntries = Object.keys(zip.files).filter(f => f.startsWith('uploads/') && !f.endsWith('/'));
		let tmpUploadDir: string | null = null;
		if (uploadEntries.length > 0) {
			tmpUploadDir = resolve(join(BACKUP_DIR, `_restore_uploads_${Date.now()}`));
			mkdirSync(tmpUploadDir, { recursive: true });
			try {
				const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);
				const EXT_TO_MIME: Record<string, string> = {
					'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
					'.png': 'image/png', '.webp': 'image/webp',
					'.pdf': 'application/pdf'
				};
				const MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500MB
				const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
				let totalExtracted = 0;
				for (const entry of uploadEntries) {
					const file = zip.file(entry);
					if (!file) continue;
					const relativePath = entry.slice('uploads/'.length);
					if (relativePath.includes('\0')) continue;
					const segments = relativePath.split(/[\\/]/);
					if (segments.some(s => s === '..' || s === '.' || s === '')) continue;
					const name = basename(relativePath);
					if (!name) continue;
					const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
					if (!ALLOWED_EXTENSIONS.has(ext)) continue;
					const subDir = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
					const destDir: string = subDir ? resolve(join(tmpUploadDir, subDir)) : tmpUploadDir;
					if (destDir !== tmpUploadDir && !destDir.startsWith(tmpUploadDir + sep)) continue;
					if (subDir && !existsSync(destDir)) mkdirSync(destDir, { recursive: true });
					const destPath = resolve(join(destDir, name));
					if (!destPath.startsWith(tmpUploadDir + sep)) continue;
					const data = await file.async('nodebuffer');
					if (data.length > MAX_FILE_SIZE) {
						throw new Error(`File "${name}" exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
					}
					const expectedMime = EXT_TO_MIME[ext];
					if (expectedMime && !verifyMagicBytes(data, expectedMime)) continue;
					totalExtracted += data.length;
					if (totalExtracted > MAX_TOTAL_SIZE) {
						throw new Error(`Backup extraction exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB total size limit`);
					}
					let fd: number | null = null;
					try {
						fd = openSync(destPath, fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
						writeSync(fd, data);
					} finally {
						if (fd !== null) closeSync(fd);
					}
				}
			} catch (e) {
				try { rmSync(tmpUploadDir, { recursive: true }); } catch (e) { console.warn('Cleanup failed:', e instanceof Error ? e.message : e); }
				throw e;
			}
		}

		if (!/^[\w/.-]+$/.test(tmpDbPath)) {
			throw new Error('Invalid temp DB path characters');
		}
		const attachPath = tmpDbPath.replace(/'/g, "''");
		db.pragma('foreign_keys = OFF');
		try {
			db.exec(`ATTACH DATABASE '${attachPath}' AS backup_db`);
			try {
				validateBackupData();

				const restoreTx = db.transaction(() => {
					const replaceTables = [
						'users', 'documents', 'settings', 'counters',
						'monitors', 'monitor_checks', 'monitor_daily',
						'agents', 'agent_metrics', 'agent_commands',
						'agent_services', 'agent_packages', 'agent_schedules',
						'agent_events', 'agent_enrollment_tokens',
						'agent_findings', 'agent_collector_results',
						'alert_rules', 'remote_sessions',
						'audit_anchor', 'audit_anchor_history',
						'backup_verifications', 'recovery_readiness',
						'ai_sessions', 'ai_messages', 'ai_tool_executions', 'ai_cost_daily'
					] as const;
					for (const table of replaceTables) {
						const exists = db.prepare("SELECT name FROM backup_db.sqlite_master WHERE type='table' AND name=?").get(table);
						if (!exists) continue;

						const mainCols = (db.prepare(`PRAGMA main.table_info(${table})`).all() as { name: string }[]).map(c => c.name);
						const backupCols = (db.prepare(`PRAGMA backup_db.table_info(${table})`).all() as { name: string }[]).map(c => c.name);
						const mainColSet = new Set(mainCols);
						const sharedCols = backupCols.filter(c => mainColSet.has(c));

						if (sharedCols.length === 0) {
							console.warn(`[backup] Skipping table "${table}": no shared columns between backup and current schema`);
							continue;
						}

						db.prepare(`DELETE FROM main.${table}`).run();

						if (sharedCols.length === mainCols.length && sharedCols.length === backupCols.length) {
							db.prepare(`INSERT INTO main.${table} SELECT * FROM backup_db.${table}`).run();
						} else {
							const colList = sharedCols.join(', ');
							db.prepare(`INSERT INTO main.${table} (${colList}) SELECT ${colList} FROM backup_db.${table}`).run();
							if (mainCols.length !== sharedCols.length) {
								console.warn(`[backup] Table "${table}": ${mainCols.length - sharedCols.length} new column(s) will use defaults (backup from older version)`);
							}
						}
					}

					const changesExists = db.prepare("SELECT name FROM backup_db.sqlite_master WHERE type='table' AND name='changes'").get();
					if (changesExists) {
						const mainChangeCols = (db.prepare('PRAGMA main.table_info(changes)').all() as { name: string }[]).map(c => c.name);
						const backupChangeCols = (db.prepare('PRAGMA backup_db.table_info(changes)').all() as { name: string }[]).map(c => c.name);
						const sharedChangeCols = backupChangeCols.filter(c => new Set(mainChangeCols).has(c));
						if (sharedChangeCols.length > 0) {
							db.prepare('DELETE FROM main.changes').run();
							if (sharedChangeCols.length === mainChangeCols.length && sharedChangeCols.length === backupChangeCols.length) {
								db.prepare(`INSERT INTO main.changes SELECT * FROM backup_db.changes`).run();
							} else {
								const colList = sharedChangeCols.join(', ');
								db.prepare(`INSERT INTO main.changes (${colList}) SELECT ${colList} FROM backup_db.changes`).run();
							}
						}
					}

					db.prepare('DELETE FROM main.sessions').run();
					db.prepare('DELETE FROM main.rate_limits').run();
					db.prepare('DELETE FROM main.mfa_used_challenges').run();
					db.prepare('DELETE FROM main.mfa_step_up_used_codes').run();
					db.prepare('DELETE FROM main.agent_enrollment_tokens WHERE used_at IS NULL').run();
					db.prepare("UPDATE main.agent_commands SET status = 'expired' WHERE status IN ('pending', 'running')").run();

					recomputeAuditAnchor({ allowTruncate: true });
				});
				restoreTx();
			} finally {
				db.exec('DETACH DATABASE backup_db');
			}
		} catch (e) {
			if (tmpUploadDir) {
				try { rmSync(tmpUploadDir, { recursive: true }); } catch (e) { console.warn('Cleanup failed:', e instanceof Error ? e.message : e); }
			}
			throw e;
		} finally {
			db.pragma('foreign_keys = ON');
		}

		events.emit('session_invalidated', { reason: 'backup_restore' });

		if (tmpUploadDir) {
			const oldUploadDir = resolve(join(BACKUP_DIR, `_old_uploads_${Date.now()}`));
			if (existsSync(UPLOAD_DIR)) {
				renameSync(UPLOAD_DIR, oldUploadDir);
			}
			try {
				renameSync(tmpUploadDir, UPLOAD_DIR);
			} catch (e) {
				if (existsSync(oldUploadDir)) {
					try { renameSync(oldUploadDir, UPLOAD_DIR); } catch { /* best effort */ }
				}
				throw e;
			}
			if (existsSync(oldUploadDir)) {
				try { rmSync(oldUploadDir, { recursive: true }); } catch { /* non-critical */ }
			}
		}
	} finally {
		try { unlinkSync(tmpDbPath); } catch (e) { console.warn('Cleanup failed:', e instanceof Error ? e.message : e); }
	}
}

const stmtCountDocsSince = db.prepare("SELECT type, COUNT(*) as count FROM documents WHERE created_at > ? GROUP BY type");
const stmtCountChangesSince = db.prepare("SELECT COUNT(*) as count FROM changes WHERE created_at > ?");

export async function previewRestore(filename: string): Promise<{
	backupTimestamp: string;
	documentsAtRisk: Record<string, number>;
	changesAtRisk: number;
	totalAtRisk: number;
}> {
	const safe = sanitizeFilename(filename);
	if (!safe) throw new Error('Invalid backup filename');
	const filePath = resolve(join(BACKUP_DIR, safe));
	if (!existsSync(filePath)) throw new Error('Backup not found');

	const MAX_ZIP_SIZE = 200 * 1024 * 1024;
	const zipStat = statSync(filePath);
	if (zipStat.size > MAX_ZIP_SIZE) throw new Error('Backup file too large (max 200MB compressed)');

	let zipData: Buffer = Buffer.from(readFileSync(filePath));
	if (safe.endsWith(ENCRYPTED_BACKUP_EXT) || isEncryptedBackup(zipData)) {
		const passphrase = getBackupPassphrase();
		if (!passphrase) throw new Error('This backup is encrypted but no passphrase is configured in Settings');
		try {
			zipData = decryptBackup(zipData, passphrase);
		} catch {
			throw new Error('Backup decryption failed: passphrase wrong or file corrupted');
		}
	}
	const zip = await JSZip.loadAsync(zipData);
	enforceZipBombCaps(zip, zipStat.size);
	const manifestFile = zip.file('manifest.json');
	if (!manifestFile) throw new Error('Invalid backup: missing manifest.json');
	const manifestStr = await manifestFile.async('string');
	if (manifestStr.length > 10_000) throw new Error('Invalid backup: manifest.json too large');
	const manifest = JSON.parse(manifestStr);
	const backupTimestamp = manifest.timestamp as string;
	if (!backupTimestamp) throw new Error('Invalid backup: missing timestamp');

	const dbFile = zip.file('itcake.db');
	if (dbFile) {
		const MAX_DB_SIZE = 100 * 1024 * 1024;
		const dbBuffer = await streamExtractCapped(dbFile, MAX_DB_SIZE, 'database file');
		const tmpPath = resolve(join(BACKUP_DIR, `_preview_${Date.now()}.db`));
		// Atomic 0o600 at create time + O_NOFOLLOW + O_EXCL — writeFileSync
		// honours umask, giving local non-root users a race window to read
		// the plaintext DB before unlinkSync runs.
		let fd: number | undefined;
		try {
			fd = openSync(tmpPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
			writeSync(fd, dbBuffer);
			closeSync(fd);
			fd = undefined;
			const backupDb = new Database(tmpPath, { readonly: true });
			rejectSuspiciousDbObjects(backupDb);
			backupDb.close();
		} finally {
			if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
			try { unlinkSync(tmpPath); } catch { /* best effort */ }
		}
	}

	const docRows = stmtCountDocsSince.all(backupTimestamp) as { type: string; count: number }[];
	const documentsAtRisk: Record<string, number> = {};
	let totalAtRisk = 0;
	for (const row of docRows) {
		documentsAtRisk[row.type] = row.count;
		totalAtRisk += row.count;
	}
	const changesRow = stmtCountChangesSince.get(backupTimestamp) as { count: number };
	const changesAtRisk = changesRow.count;

	return { backupTimestamp, documentsAtRisk, changesAtRisk, totalAtRisk };
}
