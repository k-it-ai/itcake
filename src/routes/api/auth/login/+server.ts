import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { loginSchema } from '$lib/validators.js';
import { verifyPassword, createSession } from '$lib/server/auth.js';
import { checkLoginRateLimit, recordLoginFailure, clearLoginAttempts } from '$lib/server/rate-limit.js';
import { isMfaEnabled, verifyMfaCode } from '$services/auth-mfa.js';
import { signMfaChallenge, verifyMfaChallenge } from '$lib/server/totp.js';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const ip = getClientAddress();
	checkLoginRateLimit(ip);

	const body = await parseJsonBody(request);
	const result = loginSchema.safeParse(body);
	if (!result.success) {
		recordLoginFailure(ip, '');
		throw error(400, 'Invalid request');
	}
	checkLoginRateLimit(ip, result.data.email);

	const { email, password, mfaCode, mfaToken } = result.data;

	// Two-step flow: when mfaToken is present we trust the prior password
	// proof embedded in its HMAC and skip re-verifying the password — both
	// to spare a bcrypt and to avoid re-reading credentials the client may
	// have wiped from its form. The challenge is short-lived (5 min).
	if (mfaToken) {
		const challenge = verifyMfaChallenge(mfaToken);
		if (!challenge) {
			recordLoginFailure(ip, email);
			throw error(401, 'Invalid or expired MFA challenge');
		}
		if (!mfaCode) {
			recordLoginFailure(ip, email);
			throw error(400, 'MFA code is required');
		}
		if (!verifyMfaCode(challenge.userId, mfaCode)) {
			recordLoginFailure(ip, email);
			throw error(401, 'Invalid MFA code');
		}
		// Re-load the user so we have current name/email for the session
		// reply (the challenge token only carries userId).
		const user = await verifyPassword(email, password);
		if (!user || user.id !== challenge.userId) {
			recordLoginFailure(ip, email);
			throw error(401, 'Invalid email or password');
		}
		clearLoginAttempts(ip, email);
		createSession(user.id, cookies);
		return json({ email: user.email, name: user.name });
	}

	const user = await verifyPassword(email, password);
	if (!user) {
		recordLoginFailure(ip, email);
		throw error(401, 'Invalid email or password');
	}

	if (isMfaEnabled(user.id)) {
		// Don't clear rate-limit attempts yet — the challenge isn't a full
		// success. A code is still required; without it, repeated MFA-code
		// guessing would otherwise have an unbounded window per password.
		const mfaToken = signMfaChallenge(user.id);
		return json({ mfaRequired: true, mfaToken }, { status: 200 });
	}

	clearLoginAttempts(ip, email);
	createSession(user.id, cookies);
	return json({ email: user.email, name: user.name });
};
