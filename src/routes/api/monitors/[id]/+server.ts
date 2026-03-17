import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getMonitor, getDailyHistory, getGranularChecks } from '$services/monitors.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401);

	const monitor = getMonitor(params.id);
	if (!monitor) throw error(404, 'Monitor not found');

	// Include last 24h granular checks + 90 days daily history
	const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

	return json({
		monitor,
		granular: getGranularChecks(monitor.id, since24h),
		daily: getDailyHistory(monitor.id, since90d),
	});
};
