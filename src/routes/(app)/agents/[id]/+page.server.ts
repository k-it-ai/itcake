import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { getAgent } from '$services/agents.js';
import { getRecentMetrics } from '$services/agent-metrics.js';
import { getCommandHistory } from '$services/agent-commands.js';
import { getPackages } from '$services/agent-inventory.js';
import { getServices } from '$services/agent-inventory.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const agent = getAgent(params.id);
	if (!agent) throw error(404, 'Agent not found');

	const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
	const metrics = getRecentMetrics(params.id, since48h);
	const commands = getCommandHistory(params.id, 50);
	const packages = getPackages(params.id);
	const services = getServices(params.id);

	return { agent, metrics, commands, packages, services };
};
