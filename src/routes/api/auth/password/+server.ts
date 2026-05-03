import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser, translateServiceError } from '$lib/server/request-utils.js';
import { changePassword } from '$lib/server/auth.js';
import { changePasswordSchema } from '$lib/validators.js';
import { checkAndRecordAttempt } from '$lib/server/rate-limit.js';
import { isMfaEnabled, verifyMfaCode, consumeRecoveryCode } from '$services/auth-mfa.js';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireUser(locals);

	checkAndRecordAttempt(`password:${locals.user.id}`, 5, 'Too many password change attempts');

	const body = await parseJsonBody(request);
	const result = changePasswordSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	let codeKind: ReturnType<typeof verifyMfaCode> = null;
	if (isMfaEnabled(locals.user.id)) {
		if (!result.data.mfaCode) throw error(403, 'MFA code required');
		codeKind = verifyMfaCode(locals.user.id, result.data.mfaCode);
		if (!codeKind) throw error(401, 'Invalid MFA code');
	}

	try {
		await changePassword(locals.user.id, result.data.currentPassword, result.data.newPassword);
	} catch (e) {
		return translateServiceError(e);
	}

	if (codeKind === 'recovery' && result.data.mfaCode) {
		consumeRecoveryCode(locals.user.id, result.data.mfaCode);
	}

	cookies.delete('itcake_session', { path: '/' });
	return json({ ok: true });
};
