import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError } from '$lib/server/request-utils.js';
import { changePassword } from '$lib/server/auth.js';
import { changePasswordSchema } from '$lib/validators.js';
import { ServiceError } from '$lib/server/service-error.js';
import { checkRateLimit, recordAttempt } from '$lib/server/rate-limit.js';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	if (!locals.user) throw error(401);

	checkRateLimit(`password:${locals.user.id}`, 5, 'Too many password change attempts');

	const body = await parseJsonBody(request);
	const result = changePasswordSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	try {
		await changePassword(locals.user.id, result.data.currentPassword, result.data.newPassword);
	} catch (e) {
		if (e instanceof ServiceError && e.i18nKey === 'error.currentPasswordIncorrect') {
			recordAttempt(`password:${locals.user.id}`);
		}
		return translateServiceError(e);
	}

	cookies.delete('itcake_session', { path: '/' });
	return json({ ok: true });
};
