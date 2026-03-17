import type { Actions } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { deleteSession } from '$lib/server/auth.js';

export const actions: Actions = {
	default: async ({ cookies }) => {
		deleteSession(cookies);
		throw redirect(302, '/login');
	}
};
