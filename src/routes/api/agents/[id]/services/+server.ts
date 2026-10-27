import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgent } from '#services/agents.js';
import { getServices } from '#services/agent-inventory.js';
import { notFound, requireAdmin } from '#lib/server/request-utils.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals);

	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	return json(getServices(params.id));
};
