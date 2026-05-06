import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/request-utils.js';
import { getCostSummary } from '$lib/server/ai/cost-tracker.js';

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	return json(getCostSummary());
};
