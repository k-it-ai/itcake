import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getRecentChanges } from '$services/changes.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) throw error(401);

	const parsed = parseInt(url.searchParams.get('limit') ?? '50', 10);
	const limit = Math.min(Math.max(isNaN(parsed) ? 50 : parsed, 1), 500);
	return json(getRecentChanges(limit));
};
