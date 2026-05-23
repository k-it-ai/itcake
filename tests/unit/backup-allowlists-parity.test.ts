/**
 * Parity tests for the lockstep allowlists in
 * `src/lib/server/backup-allowlists.ts`:
 *   - BACKUP_VALID_DOCUMENT_TYPES  ⇄ `documents` CHECK constraint
 *   - BACKUP_VALID_ENTITY_TYPES    ⇄ `ChangeEntityType` union (types.ts)
 *   - BACKUP_VALID_ACTIONS         ⇄ `ChangeAction` union (types.ts)
 *   - BACKUP_VALID_SETTINGS_KEYS   ⊇ `defaultSettings` keys (allowlist may
 *                                     include keys that don't have a default
 *                                     row yet — restore-only entries)
 *
 * Without these tests, adding a new document type / entity type / action
 * without updating the matching allowlist silently lets backups drop or
 * reject those rows on restore.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-allowlists-parity');

let BACKUP_VALID_DOCUMENT_TYPES: ReadonlySet<string>;
let BACKUP_VALID_ENTITY_TYPES: ReadonlySet<string>;
let BACKUP_VALID_ACTIONS: ReadonlySet<string>;
let BACKUP_VALID_SETTINGS_KEYS: ReadonlySet<string>;
let db: typeof import('../../src/lib/server/db.js').db;
let defaultSettings: typeof import('../../src/lib/server/db.js').defaultSettings;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'allowlists.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const allow = await import('../../src/lib/server/backup-allowlists.js');
	BACKUP_VALID_DOCUMENT_TYPES = allow.BACKUP_VALID_DOCUMENT_TYPES;
	BACKUP_VALID_ENTITY_TYPES = allow.BACKUP_VALID_ENTITY_TYPES;
	BACKUP_VALID_ACTIONS = allow.BACKUP_VALID_ACTIONS;
	BACKUP_VALID_SETTINGS_KEYS = allow.BACKUP_VALID_SETTINGS_KEYS;

	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	defaultSettings = dbMod.defaultSettings;
});

describe('BACKUP_VALID_DOCUMENT_TYPES ⇄ documents CHECK constraint', () => {
	it('every allowlisted document type is accepted by the CHECK constraint', () => {
		for (const t of BACKUP_VALID_DOCUMENT_TYPES) {
			const id = `parity-${t}-${randomBytes(4).toString('hex')}`;
			expect(() =>
				db.prepare('INSERT INTO documents (id, type, data) VALUES (?, ?, ?)').run(id, t, '{}')
			).not.toThrow();
			db.prepare('DELETE FROM documents WHERE id = ?').run(id);
		}
	});

	it('rejects a type not in the allowlist (smoke check)', () => {
		expect(() =>
			db.prepare('INSERT INTO documents (id, type, data) VALUES (?, ?, ?)')
				.run('parity-bogus', 'definitely_not_a_real_type', '{}')
		).toThrow(/CHECK constraint/);
	});
});

function readTypeUnion(file: string, exportName: string): string[] {
	const src = readFileSync(file, 'utf-8');
	const re = new RegExp(`export type ${exportName} =([^;]+);`);
	const m = src.match(re);
	if (!m) throw new Error(`could not find export type ${exportName} in ${file}`);
	return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

describe('BACKUP_VALID_ENTITY_TYPES ⇄ ChangeEntityType union', () => {
	it('matches exactly', () => {
		const fromTypes = new Set(
			readTypeUnion(path.resolve('src/lib/types.ts'), 'ChangeEntityType')
		);
		const fromAllowlist = new Set(BACKUP_VALID_ENTITY_TYPES);
		const missingFromAllowlist = [...fromTypes].filter(x => !fromAllowlist.has(x));
		const extraInAllowlist = [...fromAllowlist].filter(x => !fromTypes.has(x));
		expect(missingFromAllowlist, `entity types in ChangeEntityType but missing from BACKUP_VALID_ENTITY_TYPES: ${missingFromAllowlist.join(', ')}`).toEqual([]);
		expect(extraInAllowlist, `entity types in BACKUP_VALID_ENTITY_TYPES but missing from ChangeEntityType: ${extraInAllowlist.join(', ')}`).toEqual([]);
	});
});

describe('BACKUP_VALID_ACTIONS ⇄ ChangeAction union', () => {
	it('matches exactly', () => {
		const fromTypes = new Set(
			readTypeUnion(path.resolve('src/lib/types.ts'), 'ChangeAction')
		);
		const fromAllowlist = new Set(BACKUP_VALID_ACTIONS);
		const missingFromAllowlist = [...fromTypes].filter(x => !fromAllowlist.has(x));
		const extraInAllowlist = [...fromAllowlist].filter(x => !fromTypes.has(x));
		expect(missingFromAllowlist, `actions in ChangeAction but missing from BACKUP_VALID_ACTIONS: ${missingFromAllowlist.join(', ')}`).toEqual([]);
		expect(extraInAllowlist, `actions in BACKUP_VALID_ACTIONS but missing from ChangeAction: ${extraInAllowlist.join(', ')}`).toEqual([]);
	});
});

describe('BACKUP_VALID_SETTINGS_KEYS ⊇ defaultSettings keys', () => {
	it('every settings section in defaultSettings is on the backup allowlist', () => {
		const defaults = Object.keys(defaultSettings);
		const missing = defaults.filter(k => !BACKUP_VALID_SETTINGS_KEYS.has(k));
		expect(missing, `settings keys in defaultSettings but missing from BACKUP_VALID_SETTINGS_KEYS: ${missing.join(', ')}`).toEqual([]);
	});
});
