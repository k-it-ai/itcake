import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { deleteSession } from '$lib/server/auth.js';

export const POST: RequestHandler = async ({ cookies }) => {
	deleteSession(cookies);
	return json({ ok: true });
};
