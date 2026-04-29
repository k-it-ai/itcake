import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getMonitor, getGranularChecks, getDailyHistory } from '$services/monitors.js';
import type { MonitorCheckType } from '$lib/types.js';
import { notFound, requireUser } from '$lib/server/request-utils.js';

const VALID_RANGES = new Set(['24h', '7d', '30d', '365d']);
const VALID_TYPES = new Set(['ping', 'http', 'domain_expiry', 'ssl_expiry']);

export const GET: RequestHandler = async ({ params, url, locals }) => {
	requireUser(locals);

	const monitor = getMonitor(params.id);
	if (!monitor) throw notFound();

	const range = url.searchParams.get('range') || '24h';
	if (!VALID_RANGES.has(range)) throw error(400, 'Invalid range');

	const typeParam = url.searchParams.get('type');
	const checkType = typeParam && VALID_TYPES.has(typeParam) ? typeParam as MonitorCheckType : undefined;

	const now = Date.now();
	const rangeMs: Record<string, number> = {
		'24h': 24 * 60 * 60 * 1000,
		'7d': 7 * 24 * 60 * 60 * 1000,
		'30d': 30 * 24 * 60 * 60 * 1000,
		'365d': 365 * 24 * 60 * 60 * 1000,
	};

	const since = new Date(now - rangeMs[range]).toISOString();

	if (range === '24h') {
		return json({ type: 'granular', data: getGranularChecks(monitor.id, since, checkType) });
	}

	// For longer ranges, return daily aggregates
	const sinceDate = since.split('T')[0];
	return json({ type: 'daily', data: getDailyHistory(monitor.id, sinceDate, checkType) });
};
