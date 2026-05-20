/**
 * Parity test: every credential listed in SETTINGS_CREDENTIAL_AADS (the
 * runtime read/write/repair source of truth) MUST be covered by
 * scripts/rotate-session-secret.mjs's SETTINGS_PATHS. Without this a new
 * encrypted settings field could ship without being re-wrapped on
 * SESSION_SECRET rotation and the operator would silently lose it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-settings-paths-parity');
let SETTINGS_CREDENTIAL_AADS: Record<string, string>;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 's.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const mod = await import('../../src/lib/server/db.js');
	SETTINGS_CREDENTIAL_AADS = mod.SETTINGS_CREDENTIAL_AADS;
});

describe('SETTINGS_PATHS parity with SETTINGS_CREDENTIAL_AADS', () => {
	it('every credential AAD label is covered by the rotation script', () => {
		const script = readFileSync(path.resolve('scripts/rotate-session-secret.mjs'), 'utf-8');
		const missing: string[] = [];
		for (const label of Object.keys(SETTINGS_CREDENTIAL_AADS)) {
			const dot = label.indexOf('.');
			const key = label.slice(0, dot);
			const tail = label.slice(dot + 1);
			const keyRe = new RegExp(`\\bkey:\\s*['"]${key}['"]`);
			const tailRe = new RegExp(tail.split('.').map(s => `['"]${s}['"]`).join('[\\s\\S]*?'));
			if (!(keyRe.test(script) && tailRe.test(script))) {
				missing.push(label);
			}
		}
		expect(missing, `rotate-session-secret.mjs missing path for: ${missing.join(', ')}`).toEqual([]);
	});
});
