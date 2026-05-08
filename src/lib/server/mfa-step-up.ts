import { error } from '@sveltejs/kit';
import { isMfaEnabled, verifyMfaCode, consumeRecoveryCode } from '$services/auth-mfa.js';

export function requireMfaStepUp(userId: string, data: Record<string, unknown>, label = 'this action'): void {
	if (!isMfaEnabled(userId)) return;
	const code = typeof data.mfaCode === 'string' ? data.mfaCode : '';
	if (!code) throw error(403, `MFA code required for ${label}`);
	const kind = verifyMfaCode(userId, code);
	if (!kind) throw error(401, 'Invalid MFA code');
	if (kind === 'recovery' && !consumeRecoveryCode(userId, code)) {
		throw error(401, 'Invalid MFA code');
	}
}
