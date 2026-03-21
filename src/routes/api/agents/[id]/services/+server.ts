import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgent } from '$services/agents.js';
import { getServices } from '$services/agent-inventory.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401);

	const agent = getAgent(params.id);
	if (!agent) throw error(404, 'Agent not found');

	return json(getServices(params.id));
};
