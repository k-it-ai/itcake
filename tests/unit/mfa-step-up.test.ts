import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const TEST_DIR = path.resolve('data-test-mfa-step-up');

let db: typeof import('../../src/lib/server/db.js').db;
let requireMfaStepUp: typeof import('../../src/lib/server/mfa-step-up.js').requireMfaStepUp;
let initMfa: typeof import('../../src/services/auth-mfa.js').initMfa;
let enableMfa: typeof import('../../src/services/auth-mfa.js').enableMfa;
let totp: typeof import('../../src/lib/server/totp.js').totp;

const USER_WITH_MFA = 'user-stepup-mfa';
const USER_WITHOUT_MFA = 'user-stepup-nomfa';

let recoveryCodes: string[];
let totpSecret: string;

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
	initMfa = mfaMod.initMfa;
	enableMfa = mfaMod.enableMfa;
	totp = totpMod.totp;

	const hash = await bcrypt.hash('Pass1234', 4);
	db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(USER_WITH_MFA, USER_WITHOUT_MFA);
	db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
		.run(USER_WITH_MFA, 'mfa@stepup.local', 'M', hash);
	db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
		.run(USER_WITHOUT_MFA, 'nomfa@stepup.local', 'N', hash);

	const init = initMfa('mfa@stepup.local');
	totpSecret = init.secret;
	recoveryCodes = init.recoveryCodes;
	enableMfa(USER_WITH_MFA, init.secret, totp(init.secret), init.recoveryCodes);
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

	it('replay cache is per-user (different user can replay the same code string)', () => {
		const code = totp(totpSecret);
		expect(() => requireMfaStepUp(USER_WITH_MFA, { mfaCode: code })).not.toThrow();
		expect(() => requireMfaStepUp(USER_WITHOUT_MFA, { mfaCode: code })).not.toThrow();
	});
});
