import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { changePassword } from '$lib/server/auth.js';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody<{ currentPassword: string; newPassword: string }>(request);
	if (!body.currentPassword || !body.newPassword) throw error(400, 'Both current and new password are required');
	if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) throw error(400, 'New password must be at least 8 characters');
	if (body.newPassword.length > 72) throw error(400, 'Password cannot exceed 72 characters');

	try {
		await changePassword(locals.user.id, body.currentPassword, body.newPassword);
	} catch (e) {
		if (e instanceof Error && e.message === 'Current password is incorrect') {
			throw error(403, e.message);
		}
		throw e;
	}

	cookies.delete('itcake_session', { path: '/' });
	return json({ ok: true });
};
