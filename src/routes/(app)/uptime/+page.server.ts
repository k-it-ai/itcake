import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { getMonitors, getDailyHistoryForMonitors } from '$services/monitors.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const monitors = getMonitors();
	const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
	const dailyData = getDailyHistoryForMonitors(monitors.map(m => m.id), since90d);

	return { monitors, dailyData };
};
