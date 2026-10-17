import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser } from '#lib/server/request-utils.js';
import { createEnrollmentTokenSchema } from '#lib/validators-rmm.js';
import { createEnrollmentToken, getEnrollmentTokens, countActiveEnrollmentTokens } from '#services/agents.js';
import { checkAndRecordAttempt } from '#lib/server/rate-limit.js';

const MAX_ACTIVE_TOKENS = 50;
const MINT_RATE_LIMIT = 30;

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	return json(getEnrollmentTokens());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	const body = await parseJsonBody(request);
	const parsed = createEnrollmentTokenSchema.safeParse(body);
	if (!parsed.success) {
		throw error(400, parsed.error.issues.map(i => i.message).join(', '));
	}

	checkAndRecordAttempt(`enroll-token-mint:${locals.user.id}`, MINT_RATE_LIMIT, 'Too many enrollment tokens minted');
	const active = countActiveEnrollmentTokens();
	if (active >= MAX_ACTIVE_TOKENS) {
		throw error(429, `Too many active enrollment tokens (${active}); revoke unused tokens before minting more`);
	}

	const result = createEnrollmentToken(parsed.data.name, locals.user.id);
	return json(result, { status: 201 });
};
