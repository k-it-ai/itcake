import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { verifyAuditLogIntegrity } from '$lib/server/changes.js';
import { requireUser } from '$lib/server/request-utils.js';

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	const result = verifyAuditLogIntegrity();
	return json(result);
};
