import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getChangesPage } from '#services/changes.js';
import { requireAdmin } from '#lib/server/request-utils.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireAdmin(locals);

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const dir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
	const parsedLimit = parseInt(url.searchParams.get('limit') ?? '50', 10);
	const pageSize = Math.min(Math.max(isNaN(parsedLimit) ? 50 : parsedLimit, 1), 500);

	const { changes, total } = getChangesPage(page, pageSize, dir);
	return json(changes, { headers: { 'X-Total-Count': String(total) } });
};
