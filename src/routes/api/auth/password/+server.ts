import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser, translateServiceError } from '$lib/server/request-utils.js';
import { changePassword } from '$lib/server/auth.js';
import { changePasswordSchema } from '$lib/validators.js';
import { checkAndRecordAttempt } from '$lib/server/rate-limit.js';
import { isMfaEnabled, verifyMfaCode } from '$services/auth-mfa.js';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireUser(locals);

	// Atomically check + record on every entry. The previous flow only
	// charged the bucket on `currentPasswordIncorrect`, which let a
	// session attacker spam `valid-current + bad-new` (Zod-failing) or
	// successful repeated changes without consuming the limit.
	checkAndRecordAttempt(`password:${locals.user.id}`, 5, 'Too many password change attempts');

	const body = await parseJsonBody(request);
	const result = changePasswordSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	// Require the second factor when MFA is enabled. A stolen-cookie
	// attacker who only knows the current password could otherwise rotate
	// it (and lock out the legitimate operator) without ever proving
	// possession of the TOTP / recovery code. We deliberately surface a
	// distinct status (403 vs 401) so a UI can prompt for the code without
	// dropping the form state.
	if (isMfaEnabled(locals.user.id)) {
		if (!result.data.mfaCode) throw error(403, 'MFA code required');
		if (!verifyMfaCode(locals.user.id, result.data.mfaCode)) {
			throw error(401, 'Invalid MFA code');
		}
	}

	try {
		await changePassword(locals.user.id, result.data.currentPassword, result.data.newPassword);
	} catch (e) {
		return translateServiceError(e);
	}

	cookies.delete('itcake_session', { path: '/' });
	return json({ ok: true });
};
