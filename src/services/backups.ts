import { db, getSetting } from '$lib/server/db.js';
import Database from 'better-sqlite3';
import { resolve, join, basename, extname, sep } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { BACKUP_DIR, UPLOAD_DIR } from '$lib/server/data-dir.js';
import { verifyMagicBytes } from '$lib/server/file-validation.js';
import { validateTemplateSafety, sanitizeCss } from '$lib/server/template-renderer.js';
import { sanitizeRichText } from '$lib/server/sanitize.js';
import { events } from '$lib/server/events.js';
import { encryptField, decryptField } from '$lib/server/field-crypto.js';
import { encryptBackup, decryptBackup, isEncryptedBackup, ENCRYPTED_BACKUP_EXT } from '$lib/server/backup-crypto.js';
import type { BackupSettings } from '$lib/types.js';

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
	if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
}

/** Clean up stale temp files from interrupted restore/backup operations. */
function cleanupStaleTempFiles(): void {
	try {
		if (!existsSync(BACKUP_DIR)) return;
		for (const entry of readdirSync(BACKUP_DIR)) {
			if (entry.startsWith('_restore_') || entry.startsWith('_tmp_') || entry.startsWith('_old_uploads_')) {
				const fullPath = resolve(join(BACKUP_DIR, entry));
				try { rmSync(fullPath, { recursive: true }); } catch { /* best effort */ }
			}
		}
	} catch { /* non-critical */ }
}

// Run cleanup on module load (process startup)
cleanupStaleTempFiles();

/**
 * Sanitize a filename to prevent path traversal.
 * Returns null if the filename is invalid.
 */
function sanitizeFilename(filename: string): string | null {
	const safe = basename(filename);
	if (!safe || safe !== filename || safe.includes('..')) return null;
	// Accept both legacy unencrypted .zip and the .zip.enc passphrase-wrapped form.
	if (!/^backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip(\.enc)?$/.test(safe)) return null;
	const full = resolve(join(BACKUP_DIR, safe));
	if (!full.startsWith(BACKUP_DIR + '/')) return null;
	return safe;
}

/** Look up the passphrase for the optional backup encryption layer. */
function getBackupPassphrase(): string {
	const settings = getSetting<BackupSettings>('backup');
	if (!settings || !settings.encryptionPassphrase) return '';
	const raw = settings.encryptionPassphrase;
	return raw.startsWith('enc') ? decryptField(raw) : raw;
}

export async function createBackup(): Promise<BackupInfo> {
	ensureBackupDir();

	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const filename = `backup-${timestamp}.zip`;

	// Safe database copy via better-sqlite3 backup API
	const tmpDbPath = resolve(join(BACKUP_DIR, `_tmp_${timestamp}.db`));
	try {
		await db.backup(tmpDbPath);

		// Purge active sessions from the backup copy — they are ephemeral
		// and should not be included (leaked backup would expose session tokens)
		const tmpDb = new Database(tmpDbPath);
		try {
			tmpDb.exec('DELETE FROM sessions');

			// Ensure sensitive fields are encrypted in the backup copy.
			// At-rest encryption means they're already encrypted; this is a no-op safety net
			// for databases that predate the at-rest migration.
			const emailsRow = tmpDb.prepare("SELECT value FROM settings WHERE key = 'emails'").get() as { value: string } | undefined;
			if (emailsRow) {
				const emails = JSON.parse(emailsRow.value);
				if (emails.smtp?.pass && typeof emails.smtp.pass === 'string' && !emails.smtp.pass.startsWith('enc:') && !emails.smtp.pass.startsWith('enc2:')) {
					emails.smtp.pass = encryptField(emails.smtp.pass);
					tmpDb.prepare("UPDATE settings SET value = ? WHERE key = 'emails'").run(JSON.stringify(emails));
				}
			}
			const uptimeRow = tmpDb.prepare("SELECT value FROM settings WHERE key = 'uptime'").get() as { value: string } | undefined;
			if (uptimeRow) {
				const uptime = JSON.parse(uptimeRow.value);
				if (uptime.telegram?.botToken && typeof uptime.telegram.botToken === 'string' && !uptime.telegram.botToken.startsWith('enc:') && !uptime.telegram.botToken.startsWith('enc2:')) {
					uptime.telegram.botToken = encryptField(uptime.telegram.botToken);
					tmpDb.prepare("UPDATE settings SET value = ? WHERE key = 'uptime'").run(JSON.stringify(uptime));
				}
			}
		} finally {
			tmpDb.close();
		}

		const zip = new JSZip();

		// Add database
		const dbData = readFileSync(tmpDbPath);
		zip.file('itcake.db', dbData);

		// Add uploads (logos + receipts)
		if (existsSync(UPLOAD_DIR)) {
			const addDirToZip = (dir: string, zipPrefix: string) => {
				const entries = readdirSync(dir);
				for (const entry of entries) {
					const entryPath = resolve(join(dir, entry));
					if (!entryPath.startsWith(UPLOAD_DIR + '/')) continue;
					const stat = statSync(entryPath);
					if (stat.isFile()) {
						zip.file(`${zipPrefix}/${entry}`, readFileSync(entryPath));
					} else if (stat.isDirectory()) {
						addDirToZip(entryPath, `${zipPrefix}/${entry}`);
					}
				}
			};
			addDirToZip(UPLOAD_DIR, 'uploads');
		}

		// Add manifest
		const manifest = {
			version: '1.0',
			timestamp: now.toISOString(),
			nodeVersion: process.version,
			dbPath: 'itcake.db'
		};
		zip.file('manifest.json', JSON.stringify(manifest, null, 2));

		const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

		// Optional outer encryption layer. When the operator has configured a
		// passphrase, we wrap the ZIP with AES-GCM (scrypt-derived key) so a
		// leaked backup file alone — without both SESSION_SECRET AND the
		// passphrase — yields nothing useful, even if the off-site target is
		// later compromised.
		const passphrase = getBackupPassphrase();
		const encrypted = !!passphrase;
		const finalBuffer = encrypted ? encryptBackup(zipBuffer, passphrase) : zipBuffer;
		const finalName = encrypted ? filename + '.enc' : filename;

		const outputPath = resolve(join(BACKUP_DIR, finalName));
		await writeFile(outputPath, finalBuffer);

		const stat = statSync(outputPath);
		return {
			filename: finalName,
			size: stat.size,
			createdAt: now.toISOString()
		};
	} finally {
		// Clean up temp db file
		try { unlinkSync(tmpDbPath); } catch (e) { console.warn('Cleanup failed:', e instanceof Error ? e.message : e); }
	}
}

export function getBackups(): BackupInfo[] {
	ensureBackupDir();

	const files = readdirSync(BACKUP_DIR);
	return files
		.filter((f) => /^backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip(\.enc)?$/.test(f))
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

/**
 * Validate backup DB data integrity before restore.
 * Checks that all document JSON is parseable, types are valid, and no single
 * document exceeds a reasonable size. Must be called while backup_db is ATTACHed.
 */
function validateBackupData(): void {
	const VALID_TYPES = new Set(['invoice', 'proposal', 'client', 'unit', 'catalog_item', 'template', 'expense', 'ticket']);
	const MAX_DOC_JSON_SIZE = 5 * 1024 * 1024; // 5MB per document
	const VALID_SETTINGS_KEYS = new Set(['general', 'company', 'invoices', 'proposals', 'emails', 'advanced', 'uptime', 'rmm', 'backup', 'remoteDesktop']);

	// Built-in template IDs — only these are allowed to have builtIn: true
	const BUILT_IN_TEMPLATE_IDS = new Set([
		'itcake'
	]);

	// Validate documents: all JSON parseable, valid types, size limits
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

		// SECURITY: Validate templates from backups to prevent RCE.
		// A malicious backup could set builtIn: true to bypass EJS sandbox validation,
		// or inject dangerous EJS tags (<% %>, <%- %>) in template HTML.
		if (doc.type === 'template') {
			// Strip builtIn flag from non-built-in template IDs — only known built-in IDs
			// loaded from disk are trusted; custom templates must always be sandbox-validated.
			if (parsed.builtIn === true && !BUILT_IN_TEMPLATE_IDS.has(doc.id)) {
				throw new Error(`Invalid backup: template "${doc.id}" claims builtIn but is not a known built-in template`);
			}
			// Validate template HTML for all templates (built-in IDs from backups could
			// contain malicious EJS if disk templates are missing at restore time)
			{
				if (typeof parsed.html === 'string') {
					try {
						validateTemplateSafety(parsed.html, doc.id);
					} catch (e) {
						throw new Error(`Invalid backup: template "${doc.id}" contains unsafe EJS: ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				if (typeof parsed.css === 'string') {
					// Sanitize CSS to strip @import and non-data: url() — the sanitized
					// version replaces the original so restored templates are safe at rest
					parsed.css = sanitizeCss(parsed.css);
					doc.data = JSON.stringify(parsed);
					db.prepare('UPDATE backup_db.documents SET data = ? WHERE id = ?').run(doc.data, doc.id);
				}
			}
		}
	}

	// Sanitize ticket descriptions — rendered with {@html} in TicketCard.svelte,
	// so unsanitized HTML from a malicious backup could cause stored XSS.
	// sanitizeRichText() is normally applied on write (createTicket/updateTicket)
	// but backup restore bypasses the service layer.
	for (const doc of docs) {
		if (doc.type !== 'ticket') continue;
		const parsed = JSON.parse(doc.data) as Record<string, unknown>;
		if (typeof parsed.description === 'string' && parsed.description) {
			parsed.description = sanitizeRichText(parsed.description);
			doc.data = JSON.stringify(parsed);
			db.prepare('UPDATE backup_db.documents SET data = ? WHERE id = ?').run(doc.data, doc.id);
		}
	}

	// Validate settings: keys from allowlist, JSON parseable
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

	// Validate users: must have email and password_hash
	const users = db.prepare('SELECT id, email, password_hash FROM backup_db.users').all() as { id: string; email: string; password_hash: string }[];
	for (const user of users) {
		if (!user.email || !user.password_hash) {
			throw new Error(`Invalid backup: user "${user.id}" missing email or password_hash`);
		}
	}

	// Validate referential integrity: every invoice/proposal clientId must reference
	// an existing client document in the backup. A malicious or corrupted backup could
	// contain invoices pointing to non-existent clients, causing rendering/PDF errors.
	const clientIds = new Set(
		docs.filter(d => d.type === 'client').map(d => d.id)
	);
	for (const doc of docs) {
		if (doc.type !== 'invoice' && doc.type !== 'proposal' && doc.type !== 'ticket') continue;
		const parsed = JSON.parse(doc.data) as Record<string, unknown>; // JSON already validated above
		const clientId = parsed.clientId;
		if (typeof clientId === 'string' && clientId && !clientIds.has(clientId)) {
			throw new Error(`Invalid backup: ${doc.type} "${doc.id}" references non-existent client "${clientId}"`);
		}
	}

	// Validate credit note referential integrity: linkedInvoiceId must reference
	// an existing invoice document in the backup.
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

	// Validate changes (audit log) table: prevent injection of forged audit entries.
	// A malicious backup could contain entries with arbitrary entity types, actions, or
	// user IDs that would corrupt the audit trail.
	const VALID_ENTITY_TYPES = new Set(['invoice', 'creditNote', 'proposal', 'client', 'catalog_item', 'unit', 'expense', 'settings', 'template', 'monitor', 'ticket', 'agent', 'alert_rule', 'remote_session']);
	const VALID_ACTIONS = new Set(['create', 'update', 'delete', 'status_change', 'reopen', 'send_email', 'connect', 'disconnect']);
	const userIds = new Set(users.map(u => u.id));
	userIds.add('system'); // system-initiated changes (e.g. markOverdueInvoices)

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

	// Validate counters: expected keys, non-negative integer values
	const VALID_COUNTER_KEYS = new Set(['invoice_global', 'proposal_global', 'client_global', 'ticket_global', 'agent_global']);
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
	}
}

/**
 * Restore a backup by:
 * 1. Extracting the zip
 * 2. Validating manifest + DB schema
 * 3. ATTACHing the backup DB and copying all tables via SQL (no process restart needed)
 * 4. Restoring uploaded files
 */
export async function restoreBackup(filename: string): Promise<void> {
	const safe = sanitizeFilename(filename);
	if (!safe) throw new Error('Invalid backup filename');
	const filePath = resolve(join(BACKUP_DIR, safe));
	if (!existsSync(filePath)) throw new Error('Backup not found');

	// Guard against ZIP bombs: check compressed file size before loading into memory
	const MAX_ZIP_SIZE = 200 * 1024 * 1024; // 200MB compressed
	const zipStat = statSync(filePath);
	if (zipStat.size > MAX_ZIP_SIZE) throw new Error('Backup file too large (max 200MB compressed)');

	// Buffer.from() copy to normalize the readFileSync result for downstream
	// consumers (JSZip + crypto APIs are picky about NonSharedBuffer vs
	// Buffer<ArrayBufferLike> in Node 22+ TypeScript types).
	let zipData: Buffer = Buffer.from(readFileSync(filePath));
	const MAX_DECOMPRESSED_TOTAL = 500 * 1024 * 1024; // 500MB decompressed total

	// If the file is in the passphrase-encrypted form (.zip.enc, or just
	// detectable by header), unwrap before passing to JSZip. We use the
	// CURRENT settings passphrase — operators who rotate the passphrase
	// must keep the old one available for old backups.
	if (safe.endsWith(ENCRYPTED_BACKUP_EXT) || isEncryptedBackup(zipData)) {
		const passphrase = getBackupPassphrase();
		if (!passphrase) throw new Error('This backup is encrypted but no passphrase is configured in Settings');
		try {
			zipData = decryptBackup(zipData, passphrase);
		} catch {
			throw new Error('Backup decryption failed: passphrase wrong or file corrupted');
		}
	}

	// Estimate decompressed size from zip metadata before full extraction.
	// If any file lacks size metadata, fall back to compressed size * 10 as a conservative estimate.
	const zip = await JSZip.loadAsync(zipData);
	let estimatedTotal = 0;
	zip.forEach((_relativePath, file) => {
		if (!file.dir) {
			const internal = file as unknown as Record<string, unknown>;
			const data = internal._data as { uncompressedSize?: number; compressedSize?: number } | undefined;
			if (data && typeof data.uncompressedSize === 'number' && data.uncompressedSize > 0) {
				estimatedTotal += data.uncompressedSize;
			} else {
				// No metadata — assume worst-case 10:1 compression ratio from compressed size
				const compressedSize = (data && typeof data.compressedSize === 'number') ? data.compressedSize : zipStat.size;
				estimatedTotal += compressedSize * 10;
			}
		}
	});
	if (estimatedTotal > MAX_DECOMPRESSED_TOTAL) {
		throw new Error(`Backup decompressed size (~${Math.round(estimatedTotal / 1024 / 1024)}MB) exceeds ${MAX_DECOMPRESSED_TOTAL / 1024 / 1024}MB limit`);
	}

	// Validate manifest
	const manifestFile = zip.file('manifest.json');
	if (!manifestFile) throw new Error('Invalid backup: missing manifest.json');
	const manifestStr = await manifestFile.async('string');
	if (manifestStr.length > 10_000) throw new Error('Invalid backup: manifest.json too large');
	const manifest = JSON.parse(manifestStr);
	if (!manifest.version || !manifest.dbPath) throw new Error('Invalid backup: bad manifest');
	if (manifest.dbPath !== 'itcake.db') throw new Error('Invalid backup: unexpected database path');

	// Extract DB to temp file — check estimated size from metadata BEFORE decompressing
	const dbFile = zip.file(manifest.dbPath);
	if (!dbFile) throw new Error('Invalid backup: missing database file');
	const MAX_DB_SIZE = 100 * 1024 * 1024; // 100MB
	const dbInternal = dbFile as unknown as Record<string, unknown>;
	const dbMeta = dbInternal._data as { uncompressedSize?: number } | undefined;
	if (dbMeta && typeof dbMeta.uncompressedSize === 'number' && dbMeta.uncompressedSize > MAX_DB_SIZE) {
		throw new Error(`Database file exceeds ${MAX_DB_SIZE / 1024 / 1024}MB limit (estimated ${Math.round(dbMeta.uncompressedSize / 1024 / 1024)}MB)`);
	}
	const dbBuffer = await dbFile.async('nodebuffer');
	if (dbBuffer.length > MAX_DB_SIZE) {
		throw new Error(`Database file exceeds ${MAX_DB_SIZE / 1024 / 1024}MB limit`);
	}
	const tmpDbPath = resolve(join(BACKUP_DIR, `_restore_${Date.now()}.db`));

	try {
		writeFileSync(tmpDbPath, dbBuffer);

		// Validate the backup DB can be opened and has expected tables
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

		// Phase 1: Extract uploaded files to a temp dir BEFORE touching the DB.
		// This ensures file-side validation (size limits, extensions) completes
		// before the DB is modified, preventing inconsistent state.
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
					// Reject null bytes (could truncate paths in some contexts) and path traversal
					if (relativePath.includes('\0') || relativePath.includes('..')) continue;
					const name = basename(relativePath);
					if (!name) continue;
					const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
					if (!ALLOWED_EXTENSIONS.has(ext)) continue;
					const subDir = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
					const destDir: string = subDir ? resolve(join(tmpUploadDir, subDir)) : tmpUploadDir;
					// Path traversal guard: require destDir is inside tmpUploadDir (trailing sep prevents prefix collision)
					if (destDir !== tmpUploadDir && !destDir.startsWith(tmpUploadDir + sep)) continue;
					if (subDir && !existsSync(destDir)) mkdirSync(destDir, { recursive: true });
					const destPath = resolve(join(destDir, name));
					if (!destPath.startsWith(tmpUploadDir + sep)) continue;
					const data = await file.async('nodebuffer');
					if (data.length > MAX_FILE_SIZE) {
						throw new Error(`File "${name}" exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
					}
					// Verify magic bytes match the declared extension (same check as upload endpoints)
					const expectedMime = EXT_TO_MIME[ext];
					if (expectedMime && !verifyMagicBytes(data, expectedMime)) continue;
					totalExtracted += data.length;
					if (totalExtracted > MAX_TOTAL_SIZE) {
						throw new Error(`Backup extraction exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB total size limit`);
					}
					writeFileSync(destPath, data);
				}
			} catch (e) {
				try { rmSync(tmpUploadDir, { recursive: true }); } catch (e) { console.warn('Cleanup failed:', e instanceof Error ? e.message : e); }
				throw e;
			}
		}

		// Phase 2: Validate backup data integrity, then restore via ATTACH + SQL copy
		// ATTACH/DETACH must be outside the transaction (SQLite restriction)
		// Disable FK constraints to prevent CASCADE from deleting sessions when users are replaced
		// Validate path contains only expected characters before SQL interpolation
		// (ATTACH does not support parameterized paths in better-sqlite3)
		if (!/^[\w/.-]+$/.test(tmpDbPath)) {
			throw new Error('Invalid temp DB path characters');
		}
		const attachPath = tmpDbPath.replace(/'/g, "''");
		db.pragma('foreign_keys = OFF');
		try {
			db.exec(`ATTACH DATABASE '${attachPath}' AS backup_db`);
			try {
				// Validate all backup data before destructive copy
				validateBackupData();

				const restoreTx = db.transaction(() => {
					// Use db.prepare().run() — db.exec runs in autocommit and bypasses the transaction
					// SECURITY: table names are hardcoded — safe for SQL interpolation (SQLite doesn't support parameterized table names)
					// Replace data tables with backup contents
					const replaceTables = ['users', 'documents', 'settings', 'counters', 'monitors', 'monitor_checks', 'monitor_daily', 'agents', 'agent_metrics', 'agent_metrics_daily', 'agent_commands', 'agent_services', 'agent_packages', 'agent_schedules', 'agent_events', 'agent_enrollment_tokens', 'alert_rules', 'remote_sessions'] as const;
					for (const table of replaceTables) {
						const exists = db.prepare("SELECT name FROM backup_db.sqlite_master WHERE type='table' AND name=?").get(table);
						if (!exists) continue;

						// Compare column schemas to handle backups from older/newer app versions.
						// Use explicit column mapping with only shared columns instead of SELECT *
						// which would fail on column count mismatches.
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
							// Schemas match exactly — use fast SELECT *
							db.prepare(`INSERT INTO main.${table} SELECT * FROM backup_db.${table}`).run();
						} else {
							// Schema mismatch — use explicit column list for shared columns only
							const colList = sharedCols.join(', ');
							db.prepare(`INSERT INTO main.${table} (${colList}) SELECT ${colList} FROM backup_db.${table}`).run();
							if (mainCols.length !== sharedCols.length) {
								console.warn(`[backup] Table "${table}": ${mainCols.length - sharedCols.length} new column(s) will use defaults (backup from older version)`);
							}
						}
					}

					// Sensitive settings (smtp.pass, telegram.botToken) remain encrypted in the DB.
					// Backup creation encrypts them; getSetting() decrypts on read transparently.
					// No decrypt step needed here — avoids leaving plaintext on disk between
					// restore and next process restart.

					// Audit log: merge instead of replace — preserves changes made after the backup.
					// INSERT OR IGNORE skips backup entries whose IDs already exist in main.
					// This ensures post-backup audit history is retained while restoring older entries.
					const changesExists = db.prepare("SELECT name FROM backup_db.sqlite_master WHERE type='table' AND name='changes'").get();
					if (changesExists) {
						const mainChangeCols = (db.prepare('PRAGMA main.table_info(changes)').all() as { name: string }[]).map(c => c.name);
						const backupChangeCols = (db.prepare('PRAGMA backup_db.table_info(changes)').all() as { name: string }[]).map(c => c.name);
						const sharedChangeCols = backupChangeCols.filter(c => new Set(mainChangeCols).has(c));
						if (sharedChangeCols.length > 0) {
							if (sharedChangeCols.length === mainChangeCols.length && sharedChangeCols.length === backupChangeCols.length) {
								db.prepare(`INSERT OR IGNORE INTO main.changes SELECT * FROM backup_db.changes`).run();
							} else {
								const colList = sharedChangeCols.join(', ');
								db.prepare(`INSERT OR IGNORE INTO main.changes (${colList}) SELECT ${colList} FROM backup_db.changes`).run();
							}
						}
					}

					// Wipe all sessions to force re-login — never restore sessions from backups,
					// as they could reintroduce stale/compromised session tokens
					db.prepare('DELETE FROM main.sessions').run();

					// Clear rate limits to prevent stale entries from locking out the restored user
					db.prepare('DELETE FROM main.rate_limits').run();
				});
				restoreTx();
			} finally {
				db.exec('DETACH DATABASE backup_db');
			}
		} catch (e) {
			// DB restore failed — clean up extracted files (not yet swapped in)
			if (tmpUploadDir) {
				try { rmSync(tmpUploadDir, { recursive: true }); } catch (e) { console.warn('Cleanup failed:', e instanceof Error ? e.message : e); }
			}
			throw e;
		} finally {
			db.pragma('foreign_keys = ON');
		}

		// Notify connected SSE clients that all sessions have been invalidated.
		// This fires after the DB transaction commits (sessions are wiped) so
		// clients can redirect to login instead of showing stale data.
		// Uses synchronous emit — event is dispatched before the response returns.
		events.emit('session_invalidated', { reason: 'backup_restore' });

		// Phase 3: Swap uploaded files (DB already committed, files pre-validated)
		// Use rename-swap pattern: old dir is renamed aside first, so a failed
		// rename of the new dir can be rolled back by renaming old dir back.
		if (tmpUploadDir) {
			const oldUploadDir = resolve(join(BACKUP_DIR, `_old_uploads_${Date.now()}`));
			if (existsSync(UPLOAD_DIR)) {
				renameSync(UPLOAD_DIR, oldUploadDir);
			}
			try {
				renameSync(tmpUploadDir, UPLOAD_DIR);
			} catch (e) {
				// Rollback: restore old upload dir
				if (existsSync(oldUploadDir)) {
					try { renameSync(oldUploadDir, UPLOAD_DIR); } catch { /* best effort */ }
				}
				throw e;
			}
			// Cleanup old upload dir after successful swap
			if (existsSync(oldUploadDir)) {
				try { rmSync(oldUploadDir, { recursive: true }); } catch { /* non-critical */ }
			}
		}
	} finally {
		try { unlinkSync(tmpDbPath); } catch (e) { console.warn('Cleanup failed:', e instanceof Error ? e.message : e); }
	}
}

/**
 * Preview what a backup restore would overwrite.
 * Reads the backup manifest timestamp and counts documents created after it.
 */
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

	const MAX_ZIP_SIZE = 200 * 1024 * 1024; // 200MB — same limit as restoreBackup
	const zipStat = statSync(filePath);
	if (zipStat.size > MAX_ZIP_SIZE) throw new Error('Backup file too large (max 200MB compressed)');

	const zipData = readFileSync(filePath);
	const zip = await JSZip.loadAsync(zipData);
	const manifestFile = zip.file('manifest.json');
	if (!manifestFile) throw new Error('Invalid backup: missing manifest.json');
	const manifest = JSON.parse(await manifestFile.async('string'));
	const backupTimestamp = manifest.timestamp as string;
	if (!backupTimestamp) throw new Error('Invalid backup: missing timestamp');

	const dbFile = zip.file('itcake.db');
	if (dbFile) {
		const dbBuffer = await dbFile.async('nodebuffer');
		const tmpPath = resolve(join(BACKUP_DIR, `_preview_${Date.now()}.db`));
		try {
			writeFileSync(tmpPath, dbBuffer);
			const backupDb = new Database(tmpPath, { readonly: true });
			rejectSuspiciousDbObjects(backupDb);
			backupDb.close();
		} finally {
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
