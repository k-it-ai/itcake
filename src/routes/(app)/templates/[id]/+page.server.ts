import type { PageServerLoad } from './$types.js';
import { error, redirect } from '@sveltejs/kit';
import { getTemplate } from '$services/templates.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const template = getTemplate(params.id);
	if (!template) throw error(404, 'Template not found');
	return { template };
};
