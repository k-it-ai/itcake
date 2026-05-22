import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { verifyAuditLogIntegrity } from '$lib/server/changes.js';
import { requireAdmin } from '$lib/server/request-utils.js';
import { checkAndRecordAttempt } from '$lib/server/rate-limit.js';

// Admin-only — paired with `/api/changes`. Integrity output includes
// `tamperedIds`, which lets the caller enumerate which audit rows
// failed the HMAC chain. That's useful forensic info for the
// administrator but unnecessary surface for any future user-role
// account.
//
// Per-user rate limit on top of the global `/api/*` 600/min gate:
// verifyAuditLogIntegrity iterates every `changes` row and recomputes
// HMACs synchronously. On a 100k+ row log that blocks the event loop
// for seconds. The daily cron already runs it and persists the result
// to `audit_integrity_status`; this endpoint is for ad-hoc operator
// checks, not for tools that poll. 10 ad-hoc checks per 15 minutes
// is plenty.
export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	checkAndRecordAttempt(`audit-integrity:${locals.user.id}`, 10, 'Too many audit-integrity checks');
	const result = verifyAuditLogIntegrity();
	return json(result);
};
