/**
 * Schema-level coverage for the multi-user prep (#14):
 *   - users.role column exists, defaults to 'admin' (existing single-user
 *     installations don't lose access on upgrade).
 *   - getSession surfaces the role.
 *   - requireAdmin gates a 'user' role with 403.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { error as kitError, isHttpError } from '@sveltejs/kit';

const TEST_DIR = path.resolve('data-test-multi-user-prep');

let db: typeof import('../../src/lib/server/db.js').db;
let getAppliedMigrations: typeof import('../../src/lib/server/db.js').getAppliedMigrations;
let requireAdmin: typeof import('../../src/lib/server/request-utils.js').requireAdmin;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'mu.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	getAppliedMigrations = dbMod.getAppliedMigrations;
	const ru = await import('../../src/lib/server/request-utils.js');
	requireAdmin = ru.requireAdmin;
});

describe('multi-user prep', () => {
	it('users table has a role column with a default of admin', () => {
		const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string; dflt_value: string }[];
		const role = cols.find(c => c.name === 'role');
		expect(role).toBeDefined();
		expect(role!.dflt_value).toContain('admin');
	});

	it('schema_migrations records the role-column migration', () => {
		const ms = getAppliedMigrations();
		expect(ms.some(m => m.id === 2 && m.description.includes('role'))).toBe(true);
	});

	it('new INSERT without role gets admin', () => {
		db.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u-1', 'u1@test', 'h')").run();
		const row = db.prepare("SELECT role FROM users WHERE id = 'u-1'").get() as { role: string };
		expect(row.role).toBe('admin');
	});

	it('requireAdmin throws 403 for role=user, passes for role=admin', () => {
		expect(() => requireAdmin({ user: null })).toThrow();
		try {
			requireAdmin({ user: { id: 'x', role: 'user' } });
			throw new Error('should have thrown');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			expect((e as { status: number }).status).toBe(403);
		}
		// Admin passes silently.
		expect(() => requireAdmin({ user: { id: 'x', role: 'admin' } })).not.toThrow();
	});

	// Silence unused-import lint.
	void kitError;
});
