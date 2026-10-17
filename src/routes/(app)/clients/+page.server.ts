import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getClientsPaginated, getClientRevenueMap } from '#services/clients.js';
import { getSetting } from '#lib/server/db.js';
import type { GeneralSettings } from '#lib/types.js';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(302, '/login');

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const search = url.searchParams.get('q') || '';

	const result = getClientsPaginated({ search: search || undefined }, page);
	const revenueMap = getClientRevenueMap();
	const generalSettings = getSetting<GeneralSettings>('general');

	return {
		clients: result.items,
		total: result.total,
		page: result.page,
		pageSize: result.pageSize,
		revenueMap,
		currency: generalSettings.currency || 'EUR',
		filters: { search }
	};
};
