import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getRecentChanges } from '$services/changes.js';
import { requireUser } from '$lib/server/request-utils.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireUser(locals);

	const parsed = parseInt(url.searchParams.get('limit') ?? '50', 10);
	const limit = Math.min(Math.max(isNaN(parsed) ? 50 : parsed, 1), 500);
	return json(getRecentChanges(limit));
};
