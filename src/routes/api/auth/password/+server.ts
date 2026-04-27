import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError } from '$lib/server/request-utils.js';
import { changePassword } from '$lib/server/auth.js';
import { changePasswordSchema } from '$lib/validators.js';
import { checkAndRecordAttempt } from '$lib/server/rate-limit.js';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	if (!locals.user) throw error(401);

	// Atomically check + record on every entry. The previous flow only
	// charged the bucket on `currentPasswordIncorrect`, which let a
	// session attacker spam `valid-current + bad-new` (Zod-failing) or
	// successful repeated changes without consuming the limit.
	checkAndRecordAttempt(`password:${locals.user.id}`, 5, 'Too many password change attempts');

	const body = await parseJsonBody(request);
	const result = changePasswordSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	try {
		await changePassword(locals.user.id, result.data.currentPassword, result.data.newPassword);
	} catch (e) {
		return translateServiceError(e);
	}

	cookies.delete('itcake_session', { path: '/' });
	return json({ ok: true });
};
