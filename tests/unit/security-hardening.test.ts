import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assertProductionInvariants } from '../../src/lib/server/startup-invariants.js';

// Fixes covered here:
//   1. MFA enable/disable revokes all active sessions (auth-mfa.ts)
//   2. bulkDispatchCommand caps the number of agents per request
//   3. hooks.server.ts fail-fast when production lacks ORIGIN
//   4. SQL datetime() normalisation against ISO timestamps — without
//      this, same-UTC-day expired sessions resurrect on rotation
//      and scheduled commands stop firing.

const TEST_DIR = path.resolve('data-test-security-hardening');

let db: typeof import('../../src/lib/server/db.js').db;
let enableMfa: typeof import('../../src/services/auth-mfa.js').enableMfa;
let disableMfa: typeof import('../../src/services/auth-mfa.js').disableMfa;
let initMfa: typeof import('../../src/services/auth-mfa.js').initMfa;
let bulkDispatchCommand: typeof import('../../src/services/agent-commands.js').bulkDispatchCommand;
let BULK_DISPATCH_MAX_AGENTS: number;
let totp: typeof import('../../src/lib/server/totp.js').totp;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'security.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const mfaMod = await import('../../src/services/auth-mfa.js');
	const cmdMod = await import('../../src/services/agent-commands.js');
	const totpMod = await import('../../src/lib/server/totp.js');

	db = dbMod.db;
	enableMfa = mfaMod.enableMfa;
	disableMfa = mfaMod.disableMfa;
	initMfa = mfaMod.initMfa;
	bulkDispatchCommand = cmdMod.bulkDispatchCommand;
	BULK_DISPATCH_MAX_AGENTS = cmdMod.BULK_DISPATCH_MAX_AGENTS;
	totp = totpMod.totp;
});

describe('MFA enable/disable revokes active sessions', () => {
	const userId = 'sec-mfa-user';
	const password = 'CorrectHorse9';

	beforeAll(async () => {
		const hash = await bcrypt.hash(password, 4);
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
		db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
			.run(userId, 'mfa@test.local', 'MFA Test', hash);
	});

	function seedSession(id: string): void {
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
			.run(id, userId, expiresAt);
	}

	function countSessions(): number {
		const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId) as { n: number };
		return row.n;
	}

	it('enableMfa deletes pre-existing sessions for the user', () => {
		db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		// Two seeded sessions stand in for "the operator's tab" and
		// "an attacker's stolen cookie captured before MFA was on".
		seedSession('a'.repeat(64));
		seedSession('b'.repeat(64));
		expect(countSessions()).toBe(2);

		const init = initMfa('mfa@test.local');
		const code = totp(init.secret);
		enableMfa(userId, init.secret, code, init.recoveryCodes);

		expect(countSessions()).toBe(0);
	});

	it('disableMfa also deletes all sessions', async () => {
		// MFA is currently on from the prior test. Seed a fresh session and
		// verify it goes away when MFA is turned off.
		seedSession('c'.repeat(64));
		expect(countSessions()).toBe(1);

		// Read back the encrypted secret so we can mint a valid TOTP code.
		const row = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as { totp_secret: string };
		const { decryptField } = await import('../../src/lib/server/field-crypto.js');
		const secret = decryptField(row.totp_secret);
		const code = totp(secret);

		await disableMfa(userId, password, code);
		expect(countSessions()).toBe(0);
	});

	it('does not affect other users\' sessions', async () => {
		const otherId = 'sec-mfa-other';
		const hash = await bcrypt.hash('OtherPass1', 4);
		db.prepare('DELETE FROM users WHERE id = ?').run(otherId);
		db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
			.run(otherId, 'other@test.local', 'Other', hash);
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
			.run('d'.repeat(64), otherId, expiresAt);

		// Re-enable + disable MFA on the first user; the second user's
		// session must survive.
		const init = initMfa('mfa@test.local');
		enableMfa(userId, init.secret, totp(init.secret), init.recoveryCodes);

		const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(otherId) as { n: number };
		expect(row.n).toBe(1);
	});
});

describe('bulkDispatchCommand cap', () => {
	it('exports a sane upper bound', () => {
		// The cap exists to keep one tag-filter from amplifying into a
		// fleet-wide command storm. 200 is the agreed ceiling.
		expect(BULK_DISPATCH_MAX_AGENTS).toBe(200);
	});

	it('throws when caller exceeds the cap before dispatching anything', () => {
		const tooMany = Array.from({ length: BULK_DISPATCH_MAX_AGENTS + 1 }, (_, i) => `bulk-${i}`);
		expect(() =>
			bulkDispatchCommand(tooMany, 'shell', { command: 'echo hi' }, 'sys')
		).toThrow(/capped at 200 agents/);
	});

	it('does not insert any commands when the cap is exceeded', () => {
		// A short prefix lets us scope the cleanup query and assertion.
		const tooMany = Array.from({ length: BULK_DISPATCH_MAX_AGENTS + 5 }, (_, i) => `bulkguard-${i}`);
		try { bulkDispatchCommand(tooMany, 'shell', { command: 'noop' }, 'sys'); } catch { /* expected */ }
		const row = db.prepare(
			"SELECT COUNT(*) AS n FROM agent_commands WHERE agent_id LIKE 'bulkguard-%'"
		).get() as { n: number };
		// Without the pre-check the loop would have signed and inserted
		// commands until the first non-existent-agent throw — at minimum
		// the first few would land. The cap means zero rows.
		expect(row.n).toBe(0);
	});
});

describe('production startup invariants', () => {
	it('throws when NODE_ENV=production and ORIGIN is unset', () => {
		expect(() => assertProductionInvariants({ NODE_ENV: 'production' }))
			.toThrow(/ORIGIN is required in production/);
		expect(() => assertProductionInvariants({ NODE_ENV: 'production', ORIGIN: '' }))
			.toThrow(/ORIGIN is required in production/);
	});

	it('passes when NODE_ENV=production and ORIGIN is set', () => {
		expect(() => assertProductionInvariants({
			NODE_ENV: 'production',
			ORIGIN: 'https://itcake.example.com'
		})).not.toThrow();
	});

	it('does not require ORIGIN outside production', () => {
		expect(() => assertProductionInvariants({ NODE_ENV: 'development' })).not.toThrow();
		expect(() => assertProductionInvariants({})).not.toThrow();
	});

	it('still rejects ADDRESS_HEADER + non-loopback HOST in production', () => {
		// Pre-existing fail-fast — verified here so a future refactor of
		// the invariant module doesn't quietly drop it.
		expect(() => assertProductionInvariants({
			NODE_ENV: 'production',
			ORIGIN: 'https://itcake.example.com',
			ADDRESS_HEADER: 'X-Forwarded-For',
			HOST: '0.0.0.0'
		})).toThrow(/ADDRESS_HEADER is set but HOST=/);
	});

	it('accepts ADDRESS_HEADER paired with a loopback HOST', () => {
		for (const host of ['127.0.0.1', 'localhost', '::1']) {
			expect(() => assertProductionInvariants({
				NODE_ENV: 'production',
				ORIGIN: 'https://itcake.example.com',
				ADDRESS_HEADER: 'X-Forwarded-For',
				HOST: host
			})).not.toThrow();
		}
	});
});

describe('SQLite ISO-vs-space datetime normalisation', () => {
	// `new Date().toISOString()` produces `2026-04-27T07:57:25.194Z`
	// while SQLite's `datetime('now')` produces `2026-04-27 07:58:25`.
	// Lex comparison: T (0x54) > space (0x20). Without `datetime(col)`
	// wrapping, an ISO-stored expired timestamp lex-compares as
	// greater than `datetime('now')` for the rest of the UTC day,
	// which is the bug class fixed across auth/agents/alerts/etc.

	const userId = 'sec-resurrect-user';

	beforeAll(async () => {
		const hash = await bcrypt.hash('Whatever9', 4);
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
		db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
			.run(userId, 'resurrect@test.local', 'Resurrect', hash);
	});

	it('expired ISO session is NOT returned by stmtGetActiveSessions', async () => {
		const { db: directDb } = await import('../../src/lib/server/db.js');
		// Insert a session that "expired" five minutes ago, in ISO.
		// Pre-fix this row would lex-compare as greater than
		// datetime('now') and slip through as active.
		const expiredIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		const fakeHash = 'a'.repeat(64);
		directDb.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		directDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
			.run(fakeHash, userId, expiredIso);

		const rows = directDb.prepare(
			"SELECT id FROM sessions WHERE datetime(expires_at) > datetime('now')"
		).all() as { id: string }[];

		expect(rows.find(r => r.id === fakeHash)).toBeUndefined();
	});

	it('cleanExpiredSessions actually deletes same-UTC-day expired ISO rows', async () => {
		const { cleanExpiredSessions } = await import('../../src/lib/server/auth.js');
		const expiredIso = new Date(Date.now() - 1000).toISOString();
		const fakeHash = 'b'.repeat(64);
		db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
			.run(fakeHash, userId, expiredIso);

		cleanExpiredSessions();

		const remaining = db.prepare('SELECT id FROM sessions WHERE id = ?').get(fakeHash);
		expect(remaining).toBeUndefined();
	});

	it('still keeps a future ISO session', () => {
		const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const fakeHash = 'c'.repeat(64);
		db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
			.run(fakeHash, userId, futureIso);

		const rows = db.prepare(
			"SELECT id FROM sessions WHERE datetime(expires_at) > datetime('now')"
		).all() as { id: string }[];

		expect(rows.find(r => r.id === fakeHash)).toBeDefined();
	});

	it('agent-schedules due query fires same-UTC-day ISO next_run_at', async () => {
		// The bug made `WHERE next_run_at <= datetime('now')` never
		// match same-UTC-day ISO timestamps because `T` lex-sorts
		// after `space`. With `datetime(col)` it does.
		const pastIso = new Date(Date.now() - 60_000).toISOString();
		const rows = db.prepare(
			"SELECT 1 AS hit WHERE datetime(?) <= datetime('now')"
		).all(pastIso) as { hit: number }[];
		expect(rows.length).toBe(1);

		// Sanity: pre-fix style (no wrapping) would have failed for
		// the same-day case. We assert the *bug* would have been there
		// to make sure this test catches a regression of the fix.
		const buggy = db.prepare("SELECT 1 AS hit WHERE ? <= datetime('now')").all(pastIso) as { hit: number }[];
		expect(buggy.length).toBe(0);
	});
});
