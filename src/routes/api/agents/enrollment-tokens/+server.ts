import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser } from '$lib/server/request-utils.js';
import { createEnrollmentTokenSchema } from '$lib/validators-rmm.js';
import { createEnrollmentToken, getEnrollmentTokens } from '$services/agents.js';

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

	const result = createEnrollmentToken(parsed.data.name, locals.user.id);
	return json(result, { status: 201 });
};
