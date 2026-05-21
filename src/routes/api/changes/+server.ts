import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getRecentChanges } from '$services/changes.js';
import { requireAdmin } from '$lib/server/request-utils.js';

// Admin-only because the audit log carries the full diff of every settings
// + agent + monitor change — including (masked) credential rotations,
// agent rename history, and the recording-presence boolean for remote
// desktop sessions. Today this is moot (single-user), but the multi-user
// prep work added `users.role='user'` and a future invite flow; gating
// here NOW keeps a future user-role account from reading what's
// effectively the operator's activity timeline before the UI catches up.
export const GET: RequestHandler = async ({ locals, url }) => {
	requireAdmin(locals);

	const parsed = parseInt(url.searchParams.get('limit') ?? '50', 10);
	const limit = Math.min(Math.max(isNaN(parsed) ? 50 : parsed, 1), 500);
	return json(getRecentChanges(limit));
};
