import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgent } from '$services/agents.js';
import { getLatestMetric, getRecentMetrics } from '$services/agent-metrics.js';
import { notFound, requireUser } from '$lib/server/request-utils.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	requireUser(locals);

	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	const since = url.searchParams.get('since') || new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
	const latestMetric = getLatestMetric(params.id);
	const metrics = getRecentMetrics(params.id, since);

	return json({ agent, latestMetric, metrics });
};
