import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser, translateServiceError } from '$lib/server/request-utils.js';
import { changePassword } from '$lib/server/auth.js';
import { changePasswordSchema } from '$lib/validators-auth.js';
import { checkAndRecordAttempt } from '$lib/server/rate-limit.js';
import { requireMfaStepUp } from '$lib/server/mfa-step-up.js';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireUser(locals);

	checkAndRecordAttempt(`password:${locals.user.id}`, 5, 'Too many password change attempts');

	const body = await parseJsonBody(request);
	const result = changePasswordSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	requireMfaStepUp(locals.user.id, result.data, 'password change');

	try {
		await changePassword(locals.user.id, result.data.currentPassword, result.data.newPassword);
	} catch (e) {
		return translateServiceError(e);
	}

	cookies.delete('itcake_session', { path: '/' });
	return json({ ok: true });
};
