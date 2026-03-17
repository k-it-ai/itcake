import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { changePassword } from '$lib/server/auth.js';
import { changePasswordSchema } from '$lib/validators.js';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	const result = changePasswordSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	try {
		await changePassword(locals.user.id, result.data.currentPassword, result.data.newPassword);
	} catch (e) {
		if (e instanceof Error && e.message === 'Current password is incorrect') {
			throw error(403, e.message);
		}
		throw e;
	}

	cookies.delete('itcake_session', { path: '/' });
	return json({ ok: true });
};
