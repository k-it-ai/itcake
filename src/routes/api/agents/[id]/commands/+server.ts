import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { notFound, parseJsonBody, requireUser } from '#lib/server/request-utils.js';
import { dispatchCommandSchema } from '#lib/validators-rmm.js';
import { getAgent } from '#services/agents.js';
import { dispatchCommand, getCommandHistory } from '#services/agent-commands.js';
import { emitAgentEvent } from '#lib/server/agent-events.js';
import { LegacyEnrollmentError } from '#lib/server/agent-auth.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	requireUser(locals);

	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
	return json(getCommandHistory(params.id, limit));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);

	const agent = getAgent(params.id);
	if (!agent) throw notFound();
	if (!agent.enabled) throw error(400, 'Agent is disabled');
	if (agent.status === 'offline') throw error(400, 'Agent is offline');

	const body = await parseJsonBody(request);
	const parsed = dispatchCommandSchema.safeParse(body);
	if (!parsed.success) {
		throw error(400, parsed.error.issues.map(i => i.message).join(', '));
	}

	let command;
	try {
		command = dispatchCommand(
			params.id,
			parsed.data.type,
			parsed.data.payload as Record<string, unknown>,
			locals.user.id,
			parsed.data.timeoutSeconds
		);
	} catch (e) {
		if (e instanceof LegacyEnrollmentError) {
			throw error(409, e.message);
		}
		throw e;
	}
	emitAgentEvent();
	return json(command, { status: 201 });
};
