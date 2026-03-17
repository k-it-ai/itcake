import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { registerSchema } from '$lib/validators.js';
import { createFirstUserSafe, createSession, hasUsers } from '$lib/server/auth.js';
import { checkSetupRateLimit, recordSetupFailure } from '$lib/server/rate-limit.js';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	// Early check: reject registration if a user already exists, before parsing body or running bcrypt
	if (hasUsers()) {
		throw error(403, 'Registration is disabled. A user already exists.');
	}

	checkSetupRateLimit(getClientAddress());
	const body = await parseJsonBody(request);
	const result = registerSchema.safeParse(body);

	if (!result.success) {
		throw error(400, 'Invalid request');
	}

	const { email, name, password } = result.data;

	try {
		// Atomically check no users exist and create the first one
		const userId = await createFirstUserSafe(email, name, password);
		createSession(userId, cookies);
		return json({ id: userId, email, name });
	} catch (e: unknown) {
		recordSetupFailure(getClientAddress());
		if (e instanceof Error && e.message === 'REGISTRATION_CLOSED') {
			throw error(403, 'Registration is disabled. A user already exists.');
		}
		if (e instanceof Error && ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message.includes('UNIQUE'))) {
			throw error(409, 'Email already registered');
		}
		throw e;
	}
};
