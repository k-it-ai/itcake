/**
 * Parity guard for encrypted settings credentials.
 *
 * The registry lives in src/lib/server/settings-credentials.js and is shared:
 * db.ts (write/read/repair paths — via the db.ts re-export) and
 * scripts/rotate-session-secret.mjs (key rotation) must both import that one
 * module. Duplicated copies previously drifted, so a new credential could ship
 * without being re-wrapped on SESSION_SECRET rotation (silent data loss).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-settings-paths-parity');

describe('settings credential registry parity', () => {
	beforeAll(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		mkdirSync(TEST_DIR, { recursive: true });
		process.env.DATABASE_PATH = path.join(TEST_DIR, 's.db');
		process.env.DATA_DIR = TEST_DIR;
		process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	});

	it('db.ts and the rotation script share one registry module', async () => {
		const dbMod = await import('../../src/lib/server/db.js');
		const registry = await import('../../src/lib/server/settings-credentials.js');
		expect(Object.keys(dbMod.SETTINGS_CREDENTIAL_AADS)).toEqual(
			Object.keys(registry.SETTINGS_CREDENTIAL_AADS)
		);
		expect(dbMod.SETTINGS_CREDENTIAL_AADS).toEqual(registry.SETTINGS_CREDENTIAL_AADS);

		const script = readFileSync(path.resolve('scripts/rotate-session-secret.mjs'), 'utf-8');
		const dbSrc = readFileSync(path.resolve('src/lib/server/db.ts'), 'utf-8');
		expect(script).toContain("from '../src/lib/server/settings-credentials.js'");
		expect(dbSrc).toContain("from './settings-credentials.js'");
		// The rotation script must not inline its own credential list again.
		expect(script).not.toMatch(/label:\s*'/);
	});

	it('every AAD is exactly `<label>:1`', async () => {
		const registry = await import('../../src/lib/server/settings-credentials.js');
		expect(registry.SETTINGS_CREDENTIALS.length).toBeGreaterThan(0);
		for (const spec of registry.SETTINGS_CREDENTIALS) {
			expect(registry.SETTINGS_CREDENTIAL_AADS[spec.label]).toBe(`${spec.label}:1`);
		}
	});
});
