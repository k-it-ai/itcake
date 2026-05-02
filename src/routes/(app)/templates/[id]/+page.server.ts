import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getTemplate } from '$services/templates.js';
import { notFound } from '$lib/server/request-utils.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const template = getTemplate(params.id);
	if (!template) throw notFound();
	return { template };
};
