import crypto from 'node:crypto';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db.js';
import { isMfaEnabled, verifyMfaCode, consumeRecoveryCode } from '$services/auth-mfa.js';
import { checkRateLimit, recordAttempt, clearAttempts } from '$lib/server/rate-limit.js';

const REPLAY_WINDOW_SECONDS = 90;

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

const stepUpTx = db.transaction((userId: string, code: string): 'ok' | 'invalid_code' => {
	const bucket = `mfa-stepup:${userId}`;
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
