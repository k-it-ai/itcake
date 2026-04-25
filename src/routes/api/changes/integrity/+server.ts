import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { verifyAuditLogIntegrity } from '$lib/server/changes.js';

/**
 * Audit-log integrity verification. Returns counts + any tampered row IDs.
 *
 * Response shape:
 *   { total: number, verified: number, unverified: number, tamperedIds: string[] }
 *
 * `unverified` counts legacy rows (pre-migration) that have an empty hash.
 * `tamperedIds` is non-empty only when someone modified / inserted / deleted
 * a row in a way that breaks the HMAC chain — i.e. someone with direct DB
 * write access who doesn't know SESSION_SECRET.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
	const result = verifyAuditLogIntegrity();
	return json(result);
};
