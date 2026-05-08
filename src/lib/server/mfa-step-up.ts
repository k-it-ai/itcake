import crypto from 'node:crypto';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db.js';
import { isMfaEnabled, verifyMfaCode, consumeRecoveryCode } from '$services/auth-mfa.js';

const REPLAY_WINDOW_SECONDS = 90;

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

function markTotpUsed(userId: string, code: string): boolean {
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

export function requireMfaStepUp(userId: string, data: Record<string, unknown>, label = 'this action'): void {
	if (!isMfaEnabled(userId)) return;
	const code = typeof data.mfaCode === 'string' ? data.mfaCode : '';
	if (!code) throw error(403, `MFA code required for ${label}`);
	const kind = verifyMfaCode(userId, code);
	if (!kind) throw error(401, 'Invalid MFA code');
	if (kind === 'totp' && !markTotpUsed(userId, code)) {
		throw error(401, 'Invalid MFA code');
	}
	if (kind === 'recovery' && !consumeRecoveryCode(userId, code)) {
		throw error(401, 'Invalid MFA code');
	}
}
