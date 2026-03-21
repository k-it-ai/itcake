import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { dispatchCommandSchema } from '$lib/validators-rmm.js';
import { getAgent } from '$services/agents.js';
import { dispatchCommand, getCommandHistory } from '$services/agent-commands.js';
import { emitAgentEvent } from '$lib/server/agent-events.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401);

	const agent = getAgent(params.id);
	if (!agent) throw error(404, 'Agent not found');

	const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
	return json(getCommandHistory(params.id, limit));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401);

	const agent = getAgent(params.id);
	if (!agent) throw error(404, 'Agent not found');
	if (!agent.enabled) throw error(400, 'Agent is disabled');
	if (agent.status === 'offline') throw error(400, 'Agent is offline');

	const body = await parseJsonBody(request);
	const parsed = dispatchCommandSchema.safeParse(body);
	if (!parsed.success) {
		throw error(400, parsed.error.issues.map(i => i.message).join(', '));
	}

	const command = dispatchCommand(
		params.id,
		parsed.data.type,
		parsed.data.payload as Record<string, unknown>,
		locals.user.id,
		parsed.data.timeoutSeconds
	);
	emitAgentEvent();
	return json(command, { status: 201 });
};
