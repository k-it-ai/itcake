import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser, translateServiceError } from '#lib/server/request-utils.js';
import { changePassword, verifyUserPassword } from '#lib/server/auth.js';
import { changePasswordSchema } from '#lib/validators-auth.js';
import { checkAndRecordAttempt, checkAndRecordAttemptResponse } from '#lib/server/rate-limit.js';
import { requireMfaStepUp } from '#lib/server/mfa-step-up.js';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireUser(locals);

	const resp = checkAndRecordAttemptResponse(`password:${locals.user.id}`, 5, 'Too many password change attempts');
	if (resp) return resp;

	const body = await parseJsonBody(request);
	const result = changePasswordSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	if (!await verifyUserPassword(locals.user.id, result.data.currentPassword)) {
		throw error(403, 'Current password incorrect');
	}
	requireMfaStepUp(locals.user.id, result.data, 'password change');

	try {
		await changePassword(locals.user.id, result.data.currentPassword, result.data.newPassword);
	} catch (e) {
		return translateServiceError(e);
	}

	cookies.delete('itcake_session', { path: '/' });
	return json({ ok: true });
};
