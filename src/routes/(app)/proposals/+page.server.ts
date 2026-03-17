import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getProposals } from '$services/proposals.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	return { proposals: getProposals() };
};
