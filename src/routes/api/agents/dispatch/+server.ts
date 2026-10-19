import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { notFound, parseJsonBody, requireAdmin } from '#lib/server/request-utils.js';
import { bulkDispatchSchema } from '#lib/validators-rmm.js';
import { getAgentsByTags } from '#services/agents.js';
import { bulkDispatchCommand, BULK_DISPATCH_MAX_AGENTS } from '#services/agent-commands.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals);
	const body = await parseJsonBody(request);
	const parsed = bulkDispatchSchema.safeParse(body);
	if (!parsed.success) throw error(400, parsed.error.issues[0].message);

	const agents = getAgentsByTags({ any: parsed.data.tagAny, all: parsed.data.tagAll });
	if (agents.length === 0) throw notFound();
	if (agents.length > BULK_DISPATCH_MAX_AGENTS) {
		throw error(413, `Tag filter matched ${agents.length} agents (max ${BULK_DISPATCH_MAX_AGENTS} per dispatch). Narrow the filter and retry.`);
	}

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
