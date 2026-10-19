import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { getAgents, getAgentSummary } from '#services/agents.js';
import { getLatestMetricsForAgents } from '#services/agent-metrics.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const agents = getAgents();
	const summary = getAgentSummary();
	const latestMetrics = getLatestMetricsForAgents(agents.map(a => a.id));

	return {
		agents,
		summary,
		latestMetrics: Object.fromEntries(latestMetrics)
	};
};
