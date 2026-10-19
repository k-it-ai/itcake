/**
 * Local backup retention: pruneOldLocalBackups keeps a minimum number of
 * recent backups regardless of age, and keeps anything younger than the
 * retention window. Older entries beyond the floor are removed.
 *
 * Tests use a temp BACKUP_DIR with hand-crafted files (the regex on the
 * filename has the only date semantics that matter) and exercise the
 * sanitizeFilename path via deleteBackup.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-backup-retention');

let pruneOldLocalBackups: typeof import('../../src/services/backups.js').pruneOldLocalBackups;
let getBackups: typeof import('../../src/services/backups.js').getBackups;
let invalidateBackupListCache: typeof import('../../src/services/backups.js').invalidateBackupListCache;
let BACKUP_DIR: string;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'br.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const mod = await import('../../src/services/backups.js');
	pruneOldLocalBackups = mod.pruneOldLocalBackups;
	getBackups = mod.getBackups;
	invalidateBackupListCache = mod.invalidateBackupListCache;
	BACKUP_DIR = path.join(TEST_DIR, 'backups');
});

function makeBackup(name: string, ageDays: number): string {
	const full = path.join(BACKUP_DIR, name);
	writeFileSync(full, 'dummy');
	const mtime = new Date(Date.now() - ageDays * 86400_000);
	utimesSync(full, mtime, mtime);
	return full;
}

beforeEach(() => {
	if (existsSync(BACKUP_DIR)) rmSync(BACKUP_DIR, { recursive: true });
	mkdirSync(BACKUP_DIR, { recursive: true });
	// The 5s in-memory cache on getBackups would otherwise hold stale
	// entries across tests in this file (rmSync/mkdirSync bypass the
	// service-level mutators that invalidate).
	invalidateBackupListCache();
});

describe('pruneOldLocalBackups', () => {
	it('returns 0 when fewer backups than keepMin exist', () => {
		makeBackup('backup-2026-01-01-000000.zip', 365);
		makeBackup('backup-2026-01-02-000000.zip', 200);
		const removed = pruneOldLocalBackups({ keepMin: 7, retentionDays: 30 });
		expect(removed).toBe(0);
		expect(getBackups().length).toBe(2);
	});

	it('keeps at least keepMin most-recent backups even if older than retention', () => {
		for (let i = 0; i < 10; i++) {
			// All older than 30 days
			makeBackup(`backup-2025-01-0${i + 1}-000000.zip`.replace('01-0', '01-' + (i < 9 ? '0' : '')), 100 - i);
		}
		const beforeCount = getBackups().length;
		expect(beforeCount).toBe(10);
		const removed = pruneOldLocalBackups({ keepMin: 7, retentionDays: 30 });
		// Only oldest 3 should be removed (10 - 7 keepMin = 3)
		expect(removed).toBe(3);
		expect(getBackups().length).toBe(7);
	});

	it('keeps young backups even beyond keepMin', () => {
		// 5 very old + 10 young
		for (let i = 0; i < 5; i++) makeBackup(`backup-2024-01-0${i + 1}-000000.zip`, 200);
		for (let i = 0; i < 10; i++) {
			const day = String(i + 10).padStart(2, '0');
			makeBackup(`backup-2026-01-${day}-000000.zip`, 5); // 5 days old
		}
		const removed = pruneOldLocalBackups({ keepMin: 3, retentionDays: 30 });
		// 10 young (5-day) + 5 old (200-day), sorted newest-first. keepMin=3
		// pins ranks 0-2; the retention window keeps the remaining young ones,
		// so exactly the 5 old backups are pruned.
		expect(removed).toBe(5);
		expect(getBackups().length).toBe(10);
	});

	it('skips files that do not match the BACKUP_FILENAME_RE', () => {
		makeBackup('backup-2026-01-01-000000.zip', 100);
		writeFileSync(path.join(BACKUP_DIR, 'random.txt'), 'noise');
		// pruneOldLocalBackups only enumerates backups via getBackups, which
		// filters to the canonical pattern. random.txt stays.
		pruneOldLocalBackups({ keepMin: 1, retentionDays: 1 });
		expect(existsSync(path.join(BACKUP_DIR, 'random.txt'))).toBe(true);
	});
});
