import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, isHttpError } from '@sveltejs/kit';
import { verifyPassword, createSession, hasUsers } from '$lib/server/auth.js';
import { checkLoginRateLimit, recordLoginFailure, clearLoginAttempts } from '$lib/server/rate-limit.js';
import { getSetting } from '$lib/server/db.js';
import { serverT } from '$lib/i18n/server.js';
import type { GeneralSettings } from '$lib/types.js';

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

		const lang = getSetting<GeneralSettings>('general').language || 'en';
		const st = serverT(lang);

		if (typeof rawEmail !== 'string' || typeof rawPassword !== 'string' || !rawEmail || !rawPassword) {
			return fail(400, { error: st('login.errorRequired') });
		}
		const email = rawEmail.slice(0, 500);
		const password = rawPassword.slice(0, 72);

		const ip = getClientAddress();
		try {
			checkLoginRateLimit(ip, email);
		} catch (e) {
			if (isHttpError(e) && e.status === 429) {
				return fail(429, { error: st('login.errorRateLimit') });
			}
			throw e;
		}

		const user = await verifyPassword(email, password);
		if (!user) {
			recordLoginFailure(ip, email);
			return fail(401, { error: st('login.errorInvalid') });
		}

		clearLoginAttempts(ip, email);
		createSession(user.id, cookies);
		throw redirect(302, '/dashboard');
	}
};
