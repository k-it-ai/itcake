import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgent } from '$services/agents.js';
import { getPackages, getUpdatablePackages } from '$services/agent-inventory.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401);

	const agent = getAgent(params.id);
	if (!agent) throw error(404, 'Agent not found');

	const updatableOnly = url.searchParams.get('updatable') === 'true';
	const packages = updatableOnly
		? getUpdatablePackages(params.id)
		: getPackages(params.id);

	return json(packages);
};
