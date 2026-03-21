import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { getAgents, getAgentSummary } from '$services/agents.js';
import { getLatestMetric } from '$services/agent-metrics.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const agents = getAgents();
	const summary = getAgentSummary();
	const latestMetrics = new Map<string, ReturnType<typeof getLatestMetric>>();
	for (const agent of agents) {
		latestMetrics.set(agent.id, getLatestMetric(agent.id));
	}

	return {
		agents,
		summary,
		latestMetrics: Object.fromEntries(latestMetrics)
	};
};
