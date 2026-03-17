import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		throw error(401, 'Not authenticated');
	}
	return json(locals.user);
};
