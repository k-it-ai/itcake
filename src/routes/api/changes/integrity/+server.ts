import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { verifyAuditLogIntegrity } from '$lib/server/changes.js';
import { requireAdmin } from '$lib/server/request-utils.js';
import { checkAndRecordAttempt } from '$lib/server/rate-limit.js';
import { getSetting } from '$lib/server/db.js';
import type { AdvancedSettings } from '$lib/types.js';

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
// checks, not for tools that poll. Operator-tunable via
// `settings.advanced.auditIntegrityRateLimit` (0 = disable the
// per-user gate; the global IP gate still applies).
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
