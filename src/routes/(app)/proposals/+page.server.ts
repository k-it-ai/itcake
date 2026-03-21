import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getProposalsPaginated, getDistinctProposalClientNames, VALID_PROPOSAL_TRANSITIONS } from '$services/proposals.js';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(302, '/login');

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const status = url.searchParams.get('status') || '';
	const client = url.searchParams.get('client') || '';
	const search = url.searchParams.get('q') || '';
	const dateFrom = url.searchParams.get('from') || '';
	const dateTo = url.searchParams.get('to') || '';

	const result = getProposalsPaginated(
		{ status: status || undefined, clientName: client || undefined, search: search || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
		page
	);

	const clientNames = getDistinctProposalClientNames();

	return {
		proposals: result.items,
		total: result.total,
		page: result.page,
		pageSize: result.pageSize,
		clientNames,
		statusTransitions: VALID_PROPOSAL_TRANSITIONS,
		filters: { status, client, search, dateFrom, dateTo }
	};
};
