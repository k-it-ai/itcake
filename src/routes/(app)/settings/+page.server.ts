import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getBackups } from '#services/backups.js';
import { getAllSettings } from '#services/settings.js';
import { requireAdmin } from '#lib/server/request-utils.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	requireAdmin(locals);

	return {
		backups: getBackups(),
		settings: getAllSettings()
	};
};
