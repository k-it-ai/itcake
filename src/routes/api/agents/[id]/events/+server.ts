import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgent } from '$services/agents.js';
import { listEvents } from '$services/agent-events.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401);
	if (!getAgent(params.id)) throw error(404, 'Agent not found');
	const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') ?? '200', 10) || 200));
	const since = url.searchParams.get('since') || undefined;
	return json(listEvents(params.id, limit, since));
};
