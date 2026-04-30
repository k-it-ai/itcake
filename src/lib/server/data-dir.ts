import { resolve } from 'node:path';

/**
 * Reject data paths that point to sensitive system directories or contain
 * characters unsafe for SQL interpolation (ATTACH DATABASE in backup restore).
 */
const BLOCKED_PREFIXES = ['/etc', '/dev', '/proc', '/sys', '/boot', '/sbin', '/bin', '/usr/sbin', '/usr/bin'];

function validateDataPath(label: string, resolved: string): void {
	for (const prefix of BLOCKED_PREFIXES) {
		if (resolved === prefix || resolved.startsWith(prefix + '/')) {
			throw new Error(`${label} must not point to system directory "${prefix}". Got: ${resolved}`);
		}
	}
	// Reject characters unsafe for SQLite ATTACH DATABASE string interpolation
	if (/['\x00]/.test(resolved)) {
		throw new Error(`${label} must not contain single quotes or null bytes. Got: ${resolved}`);
	}
}

/**
 * Resolved data directory path — single source of truth.
 * Reads DATA_DIR from process.env (set in .env), falls back to 'data' relative to cwd.
 *
 * process.env (not `$env/dynamic/private`) so per-test overrides take effect —
 * see the matching note in db.ts.
 */
export const DATA_DIR = resolve(process.env.DATA_DIR || 'data');
validateDataPath('DATA_DIR', DATA_DIR);

export const UPLOAD_DIR = resolve(DATA_DIR, 'uploads');
export const BACKUP_DIR = resolve(DATA_DIR, 'backups');
export const RECEIPT_DIR = resolve(UPLOAD_DIR, 'receipts');
