import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getMonitor, getDailyHistory, getGranularChecks } from '#services/monitors.js';
import { notFound, requireUser } from '#lib/server/request-utils.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);

	const monitor = getMonitor(params.id);
	if (!monitor) throw notFound();

	const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

	return json({
		monitor,
		granular: getGranularChecks(monitor.id, since24h),
		daily: getDailyHistory(monitor.id, since90d),
	});
};
