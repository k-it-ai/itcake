/**
 * bcryptjs silently truncates inputs >72 bytes. `rejectIfBcryptOverlong`
 * gates registration + password change, so any stored hash was made from
 * ≤72-byte input. Without a matching byte-length gate on login an
 * attacker who knows the real password could log in with `realPass +
 * arbitrary trailing bytes` — bcrypt would truncate the suffix away and
 * match.
 *
 * This regression test confirms login rejects oversized inputs without
 * reaching bcrypt's truncating compare. Same gate on `verifyUserPassword`
 * (step-up auth) and `changePassword` (current-password check).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const TEST_DIR = path.resolve('data-test-bcrypt-truncation');

let db: typeof import('../../src/lib/server/db.js').db;
let verifyPassword: typeof import('../../src/lib/server/auth.js').verifyPassword;
let verifyUserPassword: typeof import('../../src/lib/server/auth.js').verifyUserPassword;
let changePassword: typeof import('../../src/lib/server/auth.js').changePassword;

const EMAIL = 'bcrypt-trunc@test.local';
const USER_ID = 'bcrypt-trunc-user';
// Exactly 72 ASCII bytes — bcrypt's truncation boundary.
const REAL_PASSWORD = 'A'.repeat(72);

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'bcrypt.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const authMod = await import('../../src/lib/server/auth.js');
	db = dbMod.db;
	verifyPassword = authMod.verifyPassword;
	verifyUserPassword = authMod.verifyUserPassword;
	changePassword = authMod.changePassword;

	const hash = await bcrypt.hash(REAL_PASSWORD, 4);
	db.prepare('DELETE FROM users WHERE id = ?').run(USER_ID);
	db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
		.run(USER_ID, EMAIL, 'Bcrypt Truncation', hash);
});

describe('verifyPassword: bcrypt 72-byte truncation gate', () => {
	it('accepts the real 72-byte password', async () => {
		const u = await verifyPassword(EMAIL, REAL_PASSWORD);
		expect(u?.id).toBe(USER_ID);
	});

	it('rejects realPassword + trailing bytes (the truncation bypass)', async () => {
		const oversized = REAL_PASSWORD + 'BYPASS_ATTEMPT_PADDING_TRAILING_BYTES';
		const u = await verifyPassword(EMAIL, oversized);
		expect(u).toBeNull();
	});

	it('rejects any input >72 bytes regardless of content', async () => {
		const u = await verifyPassword(EMAIL, 'X'.repeat(200));
		expect(u).toBeNull();
	});

	it('handles multi-byte UTF-8 correctly — 30 emojis = 120 bytes, rejected', async () => {
		// Each emoji here is 4 bytes; 30 of them = 120 bytes which exceeds 72.
		const u = await verifyPassword(EMAIL, '\u{1F600}'.repeat(30));
		expect(u).toBeNull();
	});

	it('still rejects wrong password of legal length (sanity check the gate did not also break the normal-rejection path)', async () => {
		const u = await verifyPassword(EMAIL, 'WrongPassword123');
		expect(u).toBeNull();
	});
});

describe('verifyUserPassword: same byte-length gate on step-up', () => {
	it('accepts the real password', async () => {
		expect(await verifyUserPassword(USER_ID, REAL_PASSWORD)).toBe(true);
	});

	it('rejects oversized input even when the prefix matches', async () => {
		expect(await verifyUserPassword(USER_ID, REAL_PASSWORD + 'EXTRA')).toBe(false);
	});
});

describe('changePassword: oversized currentPassword rejected before bcrypt', () => {
	it('rejects realPassword + trailing bytes with the standard currentPasswordIncorrect error', async () => {
		await expect(changePassword(USER_ID, REAL_PASSWORD + 'EXTRA_BYTES', 'NewPassword42')).rejects.toThrow(/currentPassword|incorrect/i);
	});
});
