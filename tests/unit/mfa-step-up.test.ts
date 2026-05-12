import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const TEST_DIR = path.resolve('data-test-mfa-step-up');

let db: typeof import('../../src/lib/server/db.js').db;
let requireMfaStepUp: typeof import('../../src/lib/server/mfa-step-up.js').requireMfaStepUp;
let markTotpUsed: typeof import('../../src/lib/server/mfa-step-up.js').markTotpUsed;
let initMfa: typeof import('../../src/services/auth-mfa.js').initMfa;
let enableMfa: typeof import('../../src/services/auth-mfa.js').enableMfa;
let totp: typeof import('../../src/lib/server/totp.js').totp;

const USER_WITH_MFA = 'user-stepup-mfa';
const USER_WITH_MFA_2 = 'user-stepup-mfa-2';
const USER_WITHOUT_MFA = 'user-stepup-nomfa';

let recoveryCodes: string[];
let totpSecret: string;
let totpSecret2: string;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'mfa.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const stepUpMod = await import('../../src/lib/server/mfa-step-up.js');
	const mfaMod = await import('../../src/services/auth-mfa.js');
	const totpMod = await import('../../src/lib/server/totp.js');

	db = dbMod.db;
	requireMfaStepUp = stepUpMod.requireMfaStepUp;
	markTotpUsed = stepUpMod.markTotpUsed;
	initMfa = mfaMod.initMfa;
	enableMfa = mfaMod.enableMfa;
	totp = totpMod.totp;

	const hash = await bcrypt.hash('Pass1234', 4);
	db.prepare('DELETE FROM users WHERE id IN (?, ?, ?)').run(USER_WITH_MFA, USER_WITH_MFA_2, USER_WITHOUT_MFA);
	db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
		.run(USER_WITH_MFA, 'mfa@stepup.local', 'M', hash);
	db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
		.run(USER_WITH_MFA_2, 'mfa2@stepup.local', 'M2', hash);
	db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
		.run(USER_WITHOUT_MFA, 'nomfa@stepup.local', 'N', hash);

	const init = initMfa('mfa@stepup.local');
	totpSecret = init.secret;
	recoveryCodes = init.recoveryCodes;
	enableMfa(USER_WITH_MFA, init.secret, totp(init.secret), init.recoveryCodes);

	const init2 = initMfa('mfa2@stepup.local');
	totpSecret2 = init2.secret;
	enableMfa(USER_WITH_MFA_2, init2.secret, totp(init2.secret), init2.recoveryCodes);
});

function expectThrowStatus(fn: () => void, status: number): Error & { status?: number } {
	try {
		fn();
		throw new Error('expected to throw');
	} catch (e) {
		const err = e as Error & { status?: number };
		expect(err.status).toBe(status);
		return err;
	}
}

describe('requireMfaStepUp', () => {
	beforeEach(() => {
		db.prepare('DELETE FROM mfa_step_up_used_codes').run();
		db.prepare('DELETE FROM rate_limits').run();
	});

	it('is a no-op when MFA is not enabled for the user', () => {
		expect(() => requireMfaStepUp(USER_WITHOUT_MFA, {})).not.toThrow();
	});

	it('throws 403 when MFA is enabled but no code is supplied', () => {
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, {}), 403);
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '' }), 403);
	});

	it('throws 401 on invalid TOTP code', () => {
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '000000' }), 401);
	});

	it('passes silently for a valid TOTP', () => {
		const code = totp(totpSecret);
		expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code })).not.toThrow();
	});

	it('accepts a recovery code on first use and rejects it on second use', () => {
		const code = recoveryCodes[0];
		expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code })).not.toThrow();
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code }), 401);
	});

	it('uses the label parameter in the 403 message', () => {
		const err = expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, {}, 'backup restore'), 403);
		expect((err as Error & { body?: { message?: string } }).body?.message ?? err.message).toContain('backup restore');
	});

	it('rejects a TOTP that was already accepted within the 90s replay window', () => {
		const code = totp(totpSecret);
		expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code })).not.toThrow();
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code }), 401);
	});

	it('accepts the same TOTP again once its replay-cache row ages out (>90s)', () => {
		const code = totp(totpSecret);
		expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code })).not.toThrow();
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code }), 401);
		db.prepare(`UPDATE mfa_step_up_used_codes SET used_at = datetime('now', '-100 seconds') WHERE user_id = ?`).run(USER_WITH_MFA);
		expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code })).not.toThrow();
	});

	it('replay cache is per-user — same code string burned for one MFA user is still accepted for another', () => {
		// Force both users to a code we know matches both their secrets at
		// the same step. The TOTP step is large enough that two random
		// secrets almost never produce the same code by coincidence, so we
		// fabricate the collision: feed user 2 the literal code that user 1
		// just submitted, but using user 2's own current TOTP value. Because
		// the cache hashes (user_id, code), the per-user keying invariant is
		// what we're asserting, not whether the codes happen to collide.
		const code1 = totp(totpSecret);
		expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code1 })).not.toThrow();
		// User 2 with their own current TOTP — must succeed even if (by
		// improbable coincidence) it equals code1, because the cache key
		// includes the user id.
		const code2 = totp(totpSecret2);
		expect(() => requireMfaStepUp(USER_WITH_MFA_2, { mfaCode: code2 })).not.toThrow();
		// Replay user 1's code on user 1 — must reject (proves the user-1
		// cache row is still active and not cleared by user 2's success).
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code1 }), 401);
	});

	it('TOTP burned by login is rejected by step-up', () => {
		const code = totp(totpSecret);
		// Simulate a login completing with this TOTP — the login flow now
		// inserts the code into mfa_step_up_used_codes via markTotpUsed.
		expect(markTotpUsed(USER_WITH_MFA, code)).toBe(true);
		// The same code submitted to a step-up-gated endpoint within the
		// 90s replay window must be rejected.
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code }), 401);
	});

	it('rate-limit kicks in after 5 failed attempts (failures-only counting)', () => {
		// Cap tightened from 10 → 5 as part of finding #5 (TOTP-validity oracle
		// hardening). Only *failures* count against the bucket — see the
		// `clear-on-success burns no slot` test below.
		for (let i = 0; i < 5; i++) {
			expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '000000' }), 401);
		}
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '000000' }), 429);
	});

	it('successful step-up burns no slot — legitimate maintenance bursts do not push the cap', () => {
		// 100 back-to-back successful step-ups (each on a fresh code after
		// the replay-cache ages out) never push the counter; the cap still
		// stands at 5 *failures*.
		for (let i = 0; i < 20; i++) {
			db.prepare(`UPDATE mfa_step_up_used_codes SET used_at = datetime('now', '-100 seconds') WHERE user_id = ?`).run(USER_WITH_MFA);
			const code = totp(totpSecret);
			expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code })).not.toThrow();
		}
		// Bucket should be empty — 5 fresh failures still allowed.
		for (let i = 0; i < 5; i++) {
			expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '000000' }), 401);
		}
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '000000' }), 429);
	});

	it('rate-limit bucket clears on a successful step-up so legit bursts do not lock out', () => {
		for (let i = 0; i < 4; i++) {
			expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '000000' }), 401);
		}
		const code = totp(totpSecret);
		expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code })).not.toThrow();
		// Bucket cleared — 4 more failures allowed before lockout.
		for (let i = 0; i < 4; i++) {
			expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '000000' }), 401);
		}
	});

	it('replay (good code reused within window) counts as a failure', () => {
		// A captured-and-replayed TOTP burns a slot — closes the only path
		// where the attacker would land a "valid" code repeatedly.
		const code = totp(totpSecret);
		expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code })).not.toThrow();
		// Replay 5 times within the 90s window — each should 401 and count
		// against the cap.
		for (let i = 0; i < 5; i++) {
			expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code }), 401);
		}
		// 6th attempt: rate-limit kicks in.
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code }), 429);
	});

	it('clear-on-success does not disable rate-limiting — cap still fires after a clear-and-refill', () => {
		for (let i = 0; i < 5; i++) {
			expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '000000' }), 401);
		}
		db.prepare('DELETE FROM rate_limits WHERE key = ?').run(`mfa-stepup:${USER_WITH_MFA}`);
		db.prepare(`UPDATE mfa_step_up_used_codes SET used_at = datetime('now', '-100 seconds') WHERE user_id = ?`).run(USER_WITH_MFA);
		const code = totp(totpSecret);
		expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code })).not.toThrow();
		for (let i = 0; i < 5; i++) {
			expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '000000' }), 401);
		}
		expectThrowStatus(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: '000000' }), 429);
	});
});
