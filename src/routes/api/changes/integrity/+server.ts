import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { verifyAuditLogIntegrity } from '$lib/server/changes.js';
import { requireAdmin } from '$lib/server/request-utils.js';

// Admin-only — paired with `/api/changes`. Integrity output includes
// `tamperedIds`, which lets the caller enumerate which audit rows
// failed the HMAC chain. That's useful forensic info for the
// administrator but unnecessary surface for any future user-role
// account.
export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	const result = verifyAuditLogIntegrity();
	return json(result);
};
