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

	// Verify the signed challenge before spending rate-limit state so the
	// per-user bucket is keyed on a trusted userId (and unsigned tokens are
	// rejected without consuming a bucket).
	const challenge = mfaToken ? verifyMfaChallenge(mfaToken) : null;
	if (mfaToken && !challenge) throw error(401, 'Invalid email or password');

	// Step-2 skips the email bucket — wrong TOTP shouldn't lock out password attempts.
	if (challenge) {
		// TOTP has a ±1-step window (three valid codes at once), so a per-IP cap
		// alone lets an attacker rotate IPs and brute-force the 6-digit space.
		// The global bucket and a per-user bucket close that.
		const globalResp = checkAndRecordAttemptResponse('login_global', 15, 'Too many login attempts');
		if (globalResp) return globalResp;
		const step2Resp = checkAndRecordAttemptResponse(`ip:${ip}`, 15, 'Too many login attempts');
		if (step2Resp) return step2Resp;
		const userResp = checkAndRecordAttemptResponse(`mfa-user:${challenge.userId}`, 5, 'Too many login attempts');
		if (userResp) return userResp;
	} else {
		const resp = checkAndRecordAttemptResponse(`login_global`, 15, 'Too many login attempts');
		if (resp) return resp;
		const resp2 = checkAndRecordAttemptResponse(`ip:${ip}`, 10, 'Too many login attempts');
		if (resp2) return resp2;
		const resp3 = checkAndRecordAttemptResponse(`email:${email.toLowerCase()}`, 3, 'Too many login attempts');
		if (resp3) return resp3;
	}

	if (mfaToken && challenge) {
		if (!consumeMfaChallenge(mfaToken)) throw error(401, 'Invalid email or password');
		const user = await verifyPassword(email, password);
		if (!user || user.id !== challenge.userId) {
			throw error(401, 'Invalid email or password');
		}
		const codeKind = mfaCode ? verifyMfaCode(challenge.userId, mfaCode) : null;
		if (!codeKind) throw error(401, 'Invalid email or password');
		if (codeKind === 'totp' && !markTotpUsed(challenge.userId, mfaCode!)) {
			throw error(401, 'Invalid email or password');
		}
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
