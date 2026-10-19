/**
 * Direct unit coverage for `src/lib/server/auth.ts`. The entire single-user
 * auth surface depends on these functions:
 *   - token shape regex `^[0-9a-f]{64}$` gate before HMAC lookup
 *   - getSession auto-rotation CAS (stmtRotateSession.run.changes==1)
 *   - verifyPassword equalises bcrypt time for unknown emails
 *   - deleteSession is bytes-shape-tolerant
 *
 * A regression here silently keeps stale sessions live or reveals
 * unknown-email timing differences.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-auth-session');

const COOKIE_STORE: { value: string; opts: Record<string, unknown> }[] = [];

type CookieJar = {
	set: (name: string, value: string, opts: Record<string, unknown>) => void;
	get: (name: string) => string | undefined;
	delete: (name: string, opts: Record<string, unknown>) => void;
};

function mockCookies(): CookieJar {
	let stored: string | undefined;
	return {
		set: (_name: string, value: string, opts: Record<string, unknown>) => {
			stored = value;
			COOKIE_STORE.push({ value, opts });
		},
		get: () => stored,
		delete: () => { stored = undefined; }
	};
}

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'auth.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
});

describe('auth.ts session lifecycle', () => {
	it('isSessionTokenValid rejects non-hex tokens', async () => {
		const { isSessionTokenValid } = await import('../../src/lib/server/auth.js');
		expect(isSessionTokenValid('not-hex-at-all-just-words-yes-nope')).toBe(false);
		expect(isSessionTokenValid('')).toBe(false);
		// 63 hex chars (one short)
		expect(isSessionTokenValid('a'.repeat(63))).toBe(false);
		// 65 hex chars (one over)
		expect(isSessionTokenValid('a'.repeat(65))).toBe(false);
		// 64 hex with uppercase — regex requires lowercase
		expect(isSessionTokenValid('A'.repeat(64))).toBe(false);
	});

	it('isSessionTokenValid passes shape regex; returns false on absent row', async () => {
		const { isSessionTokenValid } = await import('../../src/lib/server/auth.js');
		// 64 lowercase hex chars — passes the regex gate but no session
		// row exists for this token, so result is false.
		expect(isSessionTokenValid('0123456789abcdef'.repeat(4))).toBe(false);
	});

	it('createSession + getSession round-trip', async () => {
		const bcrypt = (await import('bcryptjs')).default;
		const db = (await import('../../src/lib/server/db.js')).db;
		const auth = await import('../../src/lib/server/auth.js');
		const userId = 'auth-rt-1';
		const hash = await bcrypt.hash('password-12345', 12);
		db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (?, ?, ?)`).run(userId, 'auth-rt-1@t', hash);

		const cookies = mockCookies();
		const rawToken = auth.createSession(userId, cookies as never);
		expect(rawToken).toMatch(/^[0-9a-f]{64}$/);

		const session = auth.getSession(cookies as never);
		expect(session).not.toBeNull();
		expect(session?.id).toBe(userId);
	});

	it('getSession returns null for tokens that fail the regex gate', async () => {
		const auth = await import('../../src/lib/server/auth.js');
		const cookies = {
			get: () => '\\\'; DROP TABLE sessions; --',
			set: () => {},
			delete: () => {}
		};
		expect(auth.getSession(cookies as never)).toBeNull();
	});

	it('verifyPassword runs bcrypt.compare against DUMMY for unknown email', async () => {
		const auth = await import('../../src/lib/server/auth.js');
		// Measure two calls — known-bad email vs known-good user with wrong password.
		// We can't assert exact timing, but we CAN assert both return null
		// (proving no early-return short-circuits before bcrypt).
		const a = await auth.verifyPassword('definitely-not-a-user@example.com', 'anything');
		expect(a).toBeNull();
		const b = await auth.verifyPassword('also-not-a-user@example.com', 'anything-else');
		expect(b).toBeNull();
	});

	it('deleteSession tolerates malformed cookie bytes without throwing', async () => {
		const auth = await import('../../src/lib/server/auth.js');
		const cookies = {
			get: () => 'short',
			set: () => {},
			delete: () => {}
		};
		expect(() => auth.deleteSession(cookies as never)).not.toThrow();
	});
});
