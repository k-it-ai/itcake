import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, isHttpError } from '@sveltejs/kit';
import { verifyPassword, createSession, hasUsers } from '$lib/server/auth.js';
import { checkLoginRateLimit, recordLoginFailure, clearLoginAttempts } from '$lib/server/rate-limit.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!hasUsers()) {
		throw redirect(302, '/setup');
	}
	if (locals.user) {
		throw redirect(302, '/dashboard');
	}
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const data = await request.formData();
		const rawEmail = data.get('email');
		const rawPassword = data.get('password');

		if (typeof rawEmail !== 'string' || typeof rawPassword !== 'string' || !rawEmail || !rawPassword) {
			return fail(400, { error: 'Email and password are required' });
		}
		const email = rawEmail.slice(0, 500);
		const password = rawPassword.slice(0, 72);

		const ip = getClientAddress();
		try {
			checkLoginRateLimit(ip, email);
		} catch (e) {
			if (isHttpError(e) && e.status === 429) {
				return fail(429, { error: 'Too many login attempts. Please try again later.' });
			}
			throw e;
		}

		const user = await verifyPassword(email, password);
		if (!user) {
			recordLoginFailure(ip, email);
			return fail(401, { error: 'Invalid email or password' });
		}

		clearLoginAttempts(ip, email);
		createSession(user.id, cookies);
		throw redirect(302, '/dashboard');
	}
};
