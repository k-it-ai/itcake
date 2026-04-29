import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { notFound, parseJsonBody, requireUser } from '$lib/server/request-utils.js';
import { setAgentTagsSchema } from '$lib/validators-rmm.js';
import { getAgent, setAgentTags } from '$services/agents.js';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);
	if (!getAgent(params.id)) throw notFound();
	const body = await parseJsonBody(request);
	const parsed = setAgentTagsSchema.safeParse(body);
	if (!parsed.success) throw error(400, parsed.error.issues[0].message);
	const updated = setAgentTags(params.id, parsed.data.tags, locals.user.id);
	return json(updated);
};
