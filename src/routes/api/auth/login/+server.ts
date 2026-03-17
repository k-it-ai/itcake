import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { loginSchema } from '$lib/validators.js';
import { verifyPassword, createSession } from '$lib/server/auth.js';
import { checkLoginRateLimit, recordLoginFailure, clearLoginAttempts } from '$lib/server/rate-limit.js';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const ip = getClientAddress();

	// Check IP-level rate limit before parsing body to prevent probing without consuming tokens
	checkLoginRateLimit(ip);

	const body = await parseJsonBody(request);
	const result = loginSchema.safeParse(body);

	if (!result.success) {
		recordLoginFailure(ip, ''); // consume rate-limit budget on malformed requests
		throw error(400, 'Invalid request');
	}

	// Full rate limit check (IP + email) after successful parsing
	checkLoginRateLimit(ip, result.data.email);

	const user = await verifyPassword(result.data.email, result.data.password);
	if (!user) {
		recordLoginFailure(ip, result.data.email);
		throw error(401, 'Invalid email or password');
	}

	clearLoginAttempts(ip, result.data.email);
	createSession(user.id, cookies);
	return json({ email: user.email, name: user.name });
};
