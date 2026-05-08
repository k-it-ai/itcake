import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, isHttpError } from '@sveltejs/kit';
import { verifyPassword, createSession, hasUsers } from '$lib/server/auth.js';
import { checkAndRecordLoginAttempt, checkLoginRateLimit, clearLoginAttempts, recordAttempt } from '$lib/server/rate-limit.js';
import { isMfaEnabled, verifyMfaCode, consumeRecoveryCode } from '$services/auth-mfa.js';
import { signMfaChallenge, verifyMfaChallenge, consumeMfaChallenge } from '$lib/server/totp.js';
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
		const ipEarly = getClientAddress();
		try {
			// Pre-parse IP+global guard so a flood from one IP can't exhaust
			// the parse budget; matches the JSON path in /api/auth/login.
			checkLoginRateLimit(ipEarly);
		} catch (e) {
			if (isHttpError(e) && e.status === 429) {
				const lang = getSetting<GeneralSettings>('general').language || 'en';
				return fail(429, { error: serverT(lang)('login.errorRateLimit') });
			}
			throw e;
		}

		const data = await request.formData();
		const rawEmail = data.get('email');
		const rawPassword = data.get('password');
		const rawMfaCode = data.get('mfaCode');
		const rawMfaToken = data.get('mfaToken');

		const lang = getSetting<GeneralSettings>('general').language || 'en';
		const st = serverT(lang);

		if (typeof rawEmail !== 'string' || typeof rawPassword !== 'string' || !rawEmail || !rawPassword) {
			recordAttempt('login_global');
			recordAttempt(`ip:${ipEarly}`);
			return fail(400, { error: st('login.errorRequired') });
		}
		const email = rawEmail.slice(0, 500);
		const password = rawPassword.slice(0, 72);
		const mfaCode = typeof rawMfaCode === 'string' ? rawMfaCode.trim().slice(0, 50) : '';
		const mfaToken = typeof rawMfaToken === 'string' ? rawMfaToken.slice(0, 500) : '';

		const ip = ipEarly;
		try {
			checkAndRecordLoginAttempt(ip, email);
		} catch (e) {
			if (isHttpError(e) && e.status === 429) {
				return fail(429, { error: st('login.errorRateLimit') });
			}
			throw e;
		}

		if (mfaToken) {
			const challenge = verifyMfaChallenge(mfaToken);
			if (!challenge) {
				return fail(401, { error: st('login.errorInvalid'), email });
			}
			if (!consumeMfaChallenge(mfaToken)) {
				return fail(401, { error: st('login.errorInvalid'), email });
			}
			if (!mfaCode) {
				return fail(401, { error: st('login.errorInvalid'), email });
			}
			const user = await verifyPassword(email, password);
			if (!user || user.id !== challenge.userId) {
				return fail(401, { error: st('login.errorInvalid'), email });
			}
			const codeKind = verifyMfaCode(challenge.userId, mfaCode);
			if (!codeKind) {
				return fail(401, { error: st('login.errorInvalid'), email });
			}
			if (codeKind === 'recovery' && !consumeRecoveryCode(challenge.userId, mfaCode)) {
				return fail(401, { error: st('login.errorInvalid'), email });
			}
			clearLoginAttempts(ip, email);
			createSession(user.id, cookies);
			throw redirect(302, '/dashboard');
		}

		const user = await verifyPassword(email, password);
		if (!user) {
			return fail(401, { error: st('login.errorInvalid') });
		}

		if (isMfaEnabled(user.id)) {
			return fail(200, { mfaRequired: true, mfaToken: signMfaChallenge(user.id), email });
		}

		clearLoginAttempts(ip, email);
		createSession(user.id, cookies);
		throw redirect(302, '/dashboard');
	}
};
