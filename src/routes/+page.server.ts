import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { hasUsers } from '#lib/server/auth.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!hasUsers()) {
		throw redirect(302, '/setup');
	}
	if (!locals.user) {
		throw redirect(302, '/login');
	}
	throw redirect(302, '/dashboard');
};
