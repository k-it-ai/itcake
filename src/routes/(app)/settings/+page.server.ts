import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getBackups } from '$services/backups.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	return {
		backups: getBackups()
	};
};
