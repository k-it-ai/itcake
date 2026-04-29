import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgent } from '$services/agents.js';
import { getServices } from '$services/agent-inventory.js';
import { notFound, requireUser } from '$lib/server/request-utils.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);

	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	return json(getServices(params.id));
};
