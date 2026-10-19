import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getInvoicesPaginated, getInvoiceCount, getDistinctClientNames, VALID_TRANSITIONS } from '#services/invoices.js';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(302, '/login');

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const status = url.searchParams.get('status') || '';
	const client = url.searchParams.get('client') || '';
	const search = url.searchParams.get('q') || '';
	const dateFrom = url.searchParams.get('from') || '';
	const dateTo = url.searchParams.get('to') || '';

	const sort = url.searchParams.get('sort') || '';
	const dir: 'asc' | 'desc' = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';

	const result = getInvoicesPaginated(
		{ status: status || undefined, clientName: client || undefined, search: search || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
		page,
		25,
		sort ? { key: sort, dir } : undefined
	);

	const clientNames = getDistinctClientNames();

	return {
		invoices: result.items,
		total: result.total,
		page: result.page,
		pageSize: result.pageSize,
		totalCount: getInvoiceCount(),
		clientNames,
		statusTransitions: VALID_TRANSITIONS,
		filters: { status, client, search, dateFrom, dateTo },
		sort,
		dir
	};
};
