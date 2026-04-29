import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAgent } from '$services/agents.js';
import { getPackages, getUpdatablePackages } from '$services/agent-inventory.js';
import { notFound, requireUser } from '$lib/server/request-utils.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	requireUser(locals);

	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	const updatableOnly = url.searchParams.get('updatable') === 'true';
	const packages = updatableOnly
		? getUpdatablePackages(params.id)
		: getPackages(params.id);

	return json(packages);
};
