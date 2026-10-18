/**
 * Regression: the audit log page could only ever show the newest rows —
 * `getRecentChanges()` had no offset and the page passed a hard 500 limit,
 * so older history was unreachable and the list could not be sorted.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-changes-pagination');

let db: typeof import('../../src/lib/server/db.js').db;
let getChangesPageLib: typeof import('../../src/lib/server/changes.js').getChangesPage;
let countChanges: typeof import('../../src/lib/server/changes.js').countChanges;
let getChangesPage: typeof import('../../src/services/changes.js').getChangesPage;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATA_DIR = TEST_DIR;
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'changes.db');
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	db = (await import('../../src/lib/server/db.js')).db;
	const lib = await import('../../src/lib/server/changes.js');
	getChangesPageLib = lib.getChangesPage;
	countChanges = lib.countChanges;
	getChangesPage = (await import('../../src/services/changes.js')).getChangesPage;

	const insert = db.prepare(
		'INSERT INTO changes (id, entity_type, entity_id, action, diff, user_id, created_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
	);
	for (let i = 1; i <= 5; i++) {
		insert.run(`chg-${i}`, 'invoice', `inv-${i}`, 'update', '{}', 'u-1', `2026-01-0${i} 10:00:00`, `h${i}`);
	}
});

describe('audit-log pagination', () => {
	it('pages through history newest-first by default', () => {
		expect(getChangesPageLib(2, 0, 'desc').map(c => c.id)).toEqual(['chg-5', 'chg-4']);
		expect(getChangesPageLib(2, 2, 'desc').map(c => c.id)).toEqual(['chg-3', 'chg-2']);
		expect(getChangesPageLib(2, 4, 'desc').map(c => c.id)).toEqual(['chg-1']);
	});

	it('supports oldest-first ordering', () => {
		expect(getChangesPageLib(3, 1, 'asc').map(c => c.id)).toEqual(['chg-2', 'chg-3', 'chg-4']);
	});

	it('reports the full row count', () => {
		expect(countChanges()).toBe(5);
	});

	it('service wrapper clamps paging and strips hashes', () => {
		const page = getChangesPage(1, 2, 'desc');
		expect(page.total).toBe(5);
		expect(page.changes.map(c => c.id)).toEqual(['chg-5', 'chg-4']);
		expect('hash' in (page.changes[0] as object)).toBe(false);
	});
});
