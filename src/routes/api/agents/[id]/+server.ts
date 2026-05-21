import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgent } from '$services/agents.js';
import { getLatestMetric, getRecentMetrics } from '$services/agent-metrics.js';
import { notFound, requireUser } from '$lib/server/request-utils.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	requireUser(locals);

	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	// Clamp `since` to the metrics-retention window (default 48 h). Without
	// validation, a malformed value like `0000-01-01T00:00:00Z` would dump
	// the entire metrics table for the agent in one response — bounded by
	// `metricsRetentionHours`, but still a DoS surface on operator-tuned
	// long-retention deployments.
	const defaultSince = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
	const raw = url.searchParams.get('since');
	let since = defaultSince;
	if (raw) {
		const parsed = Date.parse(raw);
		// Accept only well-formed ISO-8601 timestamps within the past year.
		const earliest = Date.now() - 365 * 24 * 60 * 60 * 1000;
		if (Number.isFinite(parsed) && parsed >= earliest && parsed <= Date.now() + 60_000) {
			since = new Date(parsed).toISOString();
		}
	}
	const latestMetric = getLatestMetric(params.id);
	const metrics = getRecentMetrics(params.id, since);

	return json({ agent, latestMetric, metrics });
};
