import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgent } from '$services/agents.js';
import { getLatestMetric, getRecentMetrics } from '$services/agent-metrics.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401);

	const agent = getAgent(params.id);
	if (!agent) throw error(404, 'Agent not found');

	const since = url.searchParams.get('since') || new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
	const latestMetric = getLatestMetric(params.id);
	const metrics = getRecentMetrics(params.id, since);

	return json({ agent, latestMetric, metrics });
};
