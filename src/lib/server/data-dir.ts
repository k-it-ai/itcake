import { resolve } from 'node:path';

const BLOCKED_PREFIXES = ['/etc', '/dev', '/proc', '/sys', '/boot', '/sbin', '/bin', '/usr/sbin', '/usr/bin'];

function validateDataPath(label: string, resolved: string): void {
	for (const prefix of BLOCKED_PREFIXES) {
		if (resolved === prefix || resolved.startsWith(prefix + '/')) {
			throw new Error(`${label} must not point to system directory "${prefix}". Got: ${resolved}`);
		}
	}
	if (/['\x00]/.test(resolved)) {
		throw new Error(`${label} must not contain single quotes or null bytes. Got: ${resolved}`);
	}
}

export const DATA_DIR = resolve(process.env.DATA_DIR || 'data');
validateDataPath('DATA_DIR', DATA_DIR);

export const UPLOAD_DIR = resolve(DATA_DIR, 'uploads');
export const BACKUP_DIR = resolve(DATA_DIR, 'backups');
export const RECEIPT_DIR = resolve(UPLOAD_DIR, 'receipts');
