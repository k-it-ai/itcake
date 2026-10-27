import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgent } from '#services/agents.js';
import { listEvents } from '#services/agent-events.js';
import { notFound, requireAdmin } from '#lib/server/request-utils.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	requireAdmin(locals);
	if (!getAgent(params.id)) throw notFound();
	const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') ?? '200', 10) || 200));
	const since = url.searchParams.get('since') || undefined;
	return json(listEvents(params.id, limit, since));
};
