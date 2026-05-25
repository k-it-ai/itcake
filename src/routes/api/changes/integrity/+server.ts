import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { verifyAuditLogIntegrity } from '$lib/server/changes.js';
import { requireAdmin } from '$lib/server/request-utils.js';
import { checkAndRecordAttempt } from '$lib/server/rate-limit.js';
import { getSetting } from '$lib/server/db.js';
import type { AdvancedSettings } from '$lib/types.js';

// Per-user rate limit: verifyAuditLogIntegrity is O(rows) and blocks the event loop.
export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	const advanced = getSetting<AdvancedSettings>('advanced');
	const cap = Math.max(0, Math.min(1000, Math.trunc(Number(advanced?.auditIntegrityRateLimit) || 0)));
	if (cap > 0) {
		checkAndRecordAttempt(`audit-integrity:${locals.user.id}`, cap, 'Too many audit-integrity checks');
	}
	const result = verifyAuditLogIntegrity();
	return json(result);
};
