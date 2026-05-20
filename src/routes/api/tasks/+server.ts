import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/request-utils.js';
import { getRecentTaskRuns } from '$lib/server/task-runs.js';

export const GET: RequestHandler = async ({ url, locals }) => {
	requireUser(locals);
	const limit = Number(url.searchParams.get('limit') ?? 50);
	return json(getRecentTaskRuns(Number.isFinite(limit) ? limit : 50));
};
