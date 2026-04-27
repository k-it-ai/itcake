import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { registerSchema } from '$lib/validators.js';
import { createFirstUserSafe, createSession, hasUsers } from '$lib/server/auth.js';
import { checkAndRecordSetupAttempt } from '$lib/server/rate-limit.js';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	// Charge the rate-limit bucket BEFORE the hasUsers() short-circuit. The
	// previous order let an unrate-limited attacker hammer this endpoint
	// after setup is complete: every request short-circuited at hasUsers()
	// without ever incrementing the limiter, giving them an unbounded
	// channel to look for race-during-uninitialized-state windows.
	checkAndRecordSetupAttempt(getClientAddress());

	// Early check: reject registration if a user already exists, before parsing body or running bcrypt
	if (hasUsers()) {
		throw error(403, 'Registration is disabled. A user already exists.');
	}

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
		if (e instanceof Error && e.message === 'REGISTRATION_CLOSED') {
			throw error(403, 'Registration is disabled. A user already exists.');
		}
		if (e instanceof Error && ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message.includes('UNIQUE'))) {
			throw error(409, 'Email already registered');
		}
		throw e;
	}
};
