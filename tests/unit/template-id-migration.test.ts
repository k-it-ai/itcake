/**
 * Migration 12: dangling template references.
 *
 * A built-in template can be renamed or removed between releases, and custom
 * templates can be deleted. Invoices, proposals, and the settings defaults can
 * then point at an id that no longer resolves, which breaks rendering. The
 * migration remaps every unresolvable reference to the current default and
 * leaves valid references untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const TEST_DIR = path.resolve('data-test-template-migration');
const DB_PATH = path.join(TEST_DIR, 'itcake.db');

// Any id that no longer resolves exercises the same path as a renamed or
// removed built-in template, without keeping the retired brand in the sources.
const LEGACY_TEMPLATE_ID = 'retired-template';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

function readDoc(id: string): { templateId?: string; total?: number } {
	const row = db.prepare('SELECT data FROM documents WHERE id = ?').get(id) as { data: string } | undefined;
	if (!row) throw new Error(`missing document ${id}`);
	return JSON.parse(row.data);
}

function readSetting(key: string): Record<string, unknown> {
	const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
	if (!row) throw new Error(`missing setting ${key}`);
	return JSON.parse(row.value);
}

beforeAll(async () => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });

	const seed = new Database(DB_PATH);
	seed.exec(`
		CREATE TABLE schema_migrations (
			id INTEGER PRIMARY KEY,
			description TEXT NOT NULL,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE documents (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			data TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '{}');
		INSERT INTO schema_migrations (id, description) VALUES (1, 'seed'), (11, 'seed');
	`);
	const insertDoc = seed.prepare('INSERT INTO documents (id, type, data) VALUES (?, ?, ?)');
	insertDoc.run('inv-legacy', 'invoice', JSON.stringify({ templateId: LEGACY_TEMPLATE_ID, total: 100 }));
	insertDoc.run('prop-legacy', 'proposal', JSON.stringify({ templateId: LEGACY_TEMPLATE_ID }));
	insertDoc.run('inv-deleted-custom', 'invoice', JSON.stringify({ templateId: 'removed-custom' }));
	insertDoc.run('inv-current', 'invoice', JSON.stringify({ templateId: 'itcake' }));
	insertDoc.run('custom-keep', 'template', JSON.stringify({ id: 'custom-keep', name: 'Custom' }));
	insertDoc.run('inv-custom', 'invoice', JSON.stringify({ templateId: 'custom-keep' }));
	seed.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
		'invoices',
		JSON.stringify({ defaultTemplate: LEGACY_TEMPLATE_ID, nextNumber: 5 })
	);
	seed.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
		'proposals',
		JSON.stringify({ defaultTemplate: 'itcake', nextNumber: 2 })
	);
	seed.close();

	process.env.DATABASE_PATH = DB_PATH;
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const mod = await import('../../src/lib/server/db.js');
	db = mod.db;
});

afterAll(() => {
	try { db?.close(); } catch { /* already closed */ }
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('template reference migration', () => {
	it('remaps invoices and proposals that point at the retired built-in id', () => {
		expect(readDoc('inv-legacy').templateId).toBe('itcake');
		expect(readDoc('prop-legacy').templateId).toBe('itcake');
		expect(readDoc('inv-legacy').total).toBe(100);
	});

	it('remaps references to deleted custom templates', () => {
		expect(readDoc('inv-deleted-custom').templateId).toBe('itcake');
	});

	it('leaves valid built-in and custom references untouched', () => {
		expect(readDoc('inv-current').templateId).toBe('itcake');
		expect(readDoc('inv-custom').templateId).toBe('custom-keep');
	});

	it('repairs the settings default without losing other settings', () => {
		const invoices = readSetting('invoices');
		expect(invoices.defaultTemplate).toBe('itcake');
		expect(invoices.nextNumber).toBe(5);
		expect(readSetting('proposals').defaultTemplate).toBe('itcake');
	});

	it('records the migration exactly once', async () => {
		const { getAppliedMigrations } = await import('../../src/lib/server/db.js');
		expect(getAppliedMigrations().some((m: { id: number }) => m.id === 12)).toBe(true);
	});
});
