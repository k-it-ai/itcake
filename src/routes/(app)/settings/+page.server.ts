import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getTemplates } from '$services/templates.js';
import { getBackups } from '$services/backups.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const templates = getTemplates().map(t => ({ id: t.id, name: t.name }));
	const backups = getBackups();

	return {
		templates,
		backups
	};
};
