import crypto from 'node:crypto';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db.js';
import { isMfaEnabled, verifyMfaCode, consumeRecoveryCode } from '$services/auth-mfa.js';
import { checkRateLimit, recordAttempt, clearAttempts } from '$lib/server/rate-limit.js';

const REPLAY_WINDOW_SECONDS = 90;

// Only count *failed* step-up attempts against this cap. Each failed code
// burns one slot; a successful step-up clears the bucket so legitimate
// operators doing back-to-back destructive ops don't get locked out. The
// cap (5) is tight enough that a SessionOnly attacker who can't see the
// TOTP secret cannot mount a productive guess-cycle even at the upper
// bound of the 90-second OTP window. Bumping above 5 weakens the
// TOTP-validity oracle without UX benefit; lowering below 3 causes
// genuine legitimate users to lock themselves out on a typo burst.
const STEP_UP_FAILURE_CAP = 5;

const stmtPruneStepUp = db.prepare(
	`DELETE FROM mfa_step_up_used_codes WHERE used_at < datetime('now', ?)`
);
const stmtMarkStepUp = db.prepare(
	'INSERT INTO mfa_step_up_used_codes (user_id, code_hash) VALUES (?, ?)'
);

function hashStepUpCode(code: string): string {
	const normalised = code.replace(/\s+/g, '');
	return crypto.createHmac('sha256', env.SESSION_SECRET || '').update(normalised).digest('hex');
}

export function markTotpUsed(userId: string, code: string): boolean {
	try {
		stmtPruneStepUp.run(`-${REPLAY_WINDOW_SECONDS} seconds`);
	} catch { /* best effort */ }
	try {
		stmtMarkStepUp.run(userId, hashStepUpCode(code));
		return true;
	} catch (e) {
		const sqliteCode = (e as { code?: string }).code;
		if (sqliteCode === 'SQLITE_CONSTRAINT_PRIMARYKEY' || sqliteCode === 'SQLITE_CONSTRAINT_UNIQUE' || sqliteCode === 'SQLITE_CONSTRAINT') {
			return false;
		}
		throw e;
	}
}

// Atomic step-up: rate-limit check + TOTP verify + replay-cache insert all
// inside ONE `db.transaction()` so concurrent parallel POSTs to step-up-gated
// endpoints serialise on the SQLite write lock. The prior implementation did
// `checkRateLimit` then `recordAttempt` as two separate writes, giving N
// parallel requests a window where each saw the pre-increment count — the
// cap effectively relaxed by parallelism. better-sqlite3 transactions are
// sync; `verifyMfaCode` / `consumeRecoveryCode` / `markTotpUsed` are all
// sync (HMAC/AES-GCM/INSERT), so wrapping the whole flow is safe.
const stepUpTx = db.transaction((userId: string, code: string): 'ok' | 'invalid_code' => {
	const bucket = `mfa-stepup:${userId}`;
	// Re-check inside the transaction so the read sees committed state.
	checkRateLimit(bucket, STEP_UP_FAILURE_CAP, 'Too many MFA step-up attempts');
	const kind = verifyMfaCode(userId, code);
	if (!kind) {
		recordAttempt(bucket);
		return 'invalid_code';
	}
	if (kind === 'totp' && !markTotpUsed(userId, code)) {
		recordAttempt(bucket);
		return 'invalid_code';
	}
	if (kind === 'recovery' && !consumeRecoveryCode(userId, code)) {
		recordAttempt(bucket);
		return 'invalid_code';
	}
	clearAttempts(bucket);
	return 'ok';
});

export function requireMfaStepUp(userId: string, data: Record<string, unknown>, label = 'this action'): void {
	if (!isMfaEnabled(userId)) return;
	const code = typeof data.mfaCode === 'string' ? data.mfaCode : '';
	if (!code) throw error(403, `MFA code required for ${label}`);
	const result = stepUpTx(userId, code);
	if (result !== 'ok') throw error(401, 'Invalid MFA code');
}
