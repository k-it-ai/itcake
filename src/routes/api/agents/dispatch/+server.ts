import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { bulkDispatchSchema } from '$lib/validators-rmm.js';
import { getAgentsByTags } from '$services/agents.js';
import { bulkDispatchCommand } from '$services/agent-commands.js';

/**
 * Bulk-dispatch a command to all agents matching a tag filter. The handler
 * resolves the tag filter to an explicit agent set, then individually
 * signs and inserts each command — no fanout primitive at the DB layer,
 * so each command keeps its independent HMAC signature.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);
	const body = await parseJsonBody(request);
	const parsed = bulkDispatchSchema.safeParse(body);
	if (!parsed.success) throw error(400, parsed.error.issues[0].message);

	const agents = getAgentsByTags({ any: parsed.data.tagAny, all: parsed.data.tagAll });
	if (agents.length === 0) throw error(404, 'No agents matched the tag filter');

	const result = bulkDispatchCommand(
		agents.map(a => a.id),
		parsed.data.type,
		parsed.data.payload,
		locals.user.id,
		parsed.data.timeoutSeconds
	);
	return json({
		dispatched: result.dispatched.map(c => ({ id: c.id, agentId: c.agentId })),
		failed: result.failed
	});
};
