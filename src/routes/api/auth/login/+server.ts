import { json, error, type RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '#lib/server/request-utils.js';
import { loginSchema } from '#lib/validators-auth.js';
import { verifyPassword, createSession } from '#lib/server/auth.js';
import { checkLoginRateLimit, checkAndRecordLoginAttempt, checkAndRecordLoginStep2Attempt, clearLoginAttempts, recordAttempt, checkAndRecordAttemptResponse, checkRateLimitResponse, rateLimitResponse } from '#lib/server/rate-limit.js';
import { isMfaEnabled, verifyMfaCode, consumeRecoveryCode } from '#services/auth-mfa.js';
import { signMfaChallenge, verifyMfaChallenge, consumeMfaChallenge } from '#lib/server/totp.js';
import { markTotpUsed } from '#lib/server/mfa-step-up.js';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const ip = getClientAddress();
	const limitResp = checkRateLimitResponse('login_global', 15, 'Too many login attempts');
	if (limitResp) return limitResp;
	const ipResp = checkRateLimitResponse(`ip:${ip}`, 10, 'Too many login attempts');
	if (ipResp) return ipResp;

	const body = await parseJsonBody(request);
	const result = loginSchema.safeParse(body);
	if (!result.success) {
		recordAttempt('login_global');
		recordAttempt(`ip:${ip}`);
		throw error(400, 'Invalid request');
	}

	const { email, password, mfaCode, mfaToken } = result.data;

	// Step-2 skips the email bucket — wrong TOTP shouldn't lock out password attempts.
	if (mfaToken) {
		const step2Resp = checkAndRecordAttemptResponse(`ip:${ip}`, 15, 'Too many login attempts');
		if (step2Resp) return step2Resp;
	} else {
		const resp = checkAndRecordAttemptResponse(`login_global`, 15, 'Too many login attempts');
		if (resp) return resp;
		const resp2 = checkAndRecordAttemptResponse(`ip:${ip}`, 10, 'Too many login attempts');
		if (resp2) return resp2;
		const resp3 = checkAndRecordAttemptResponse(`email:${email.toLowerCase()}`, 3, 'Too many login attempts');
		if (resp3) return resp3;
	}

	if (mfaToken) {
		const challenge = verifyMfaChallenge(mfaToken);
		if (!challenge) throw error(401, 'Invalid email or password');
		if (!consumeMfaChallenge(mfaToken)) throw error(401, 'Invalid email or password');
		const user = await verifyPassword(email, password);
		if (!user || user.id !== challenge.userId) {
			throw error(401, 'Invalid email or password');
		}
		const codeKind = mfaCode ? verifyMfaCode(challenge.userId, mfaCode) : null;
		if (!codeKind) throw error(401, 'Invalid email or password');
		if (codeKind === 'totp') markTotpUsed(challenge.userId, mfaCode!);
		if (codeKind === 'recovery' && !consumeRecoveryCode(challenge.userId, mfaCode!)) {
			throw error(401, 'Invalid email or password');
		}
		clearLoginAttempts(ip, email);
		createSession(user.id, cookies);
		return json({ email: user.email, name: user.name });
	}

	const user = await verifyPassword(email, password);
	if (!user) {
		throw error(401, 'Invalid email or password');
	}

	if (isMfaEnabled(user.id)) {
		const mfaToken = signMfaChallenge(user.id);
		return json({ mfaRequired: true, mfaToken }, { status: 200 });
	}

	clearLoginAttempts(ip, email);
	createSession(user.id, cookies);
	return json({ email: user.email, name: user.name });
};
