import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { loginSchema } from '$lib/validators.js';
import { verifyPassword, createSession } from '$lib/server/auth.js';
import { checkLoginRateLimit, checkAndRecordLoginAttempt, clearLoginAttempts, recordAttempt } from '$lib/server/rate-limit.js';
import { isMfaEnabled, verifyMfaCode } from '$services/auth-mfa.js';
import { signMfaChallenge, verifyMfaChallenge, consumeMfaChallenge } from '$lib/server/totp.js';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const ip = getClientAddress();
	// Pre-parse IP-only check so we cap obviously-flooding sources before
	// even reading the body. The atomic increment happens once we know
	// the email below.
	checkLoginRateLimit(ip);

	const body = await parseJsonBody(request);
	const result = loginSchema.safeParse(body);
	if (!result.success) {
		// Malformed-flood guard: charge ONLY the IP bucket. The previous
		// implementation called checkAndRecordLoginAttempt(ip, '') which
		// also incremented `email:` (empty key) — a single shared bucket
		// across every malformed-body attacker that legitimate users
		// never key on, effectively a no-op for the email dimension.
		recordAttempt('login_global');
		recordAttempt(`ip:${ip}`);
		throw error(400, 'Invalid request');
	}

	const { email, password, mfaCode, mfaToken } = result.data;

	// Atomically check-and-record across all three buckets BEFORE we run
	// bcrypt. Without this, the ~100 ms bcrypt window let dozens of
	// concurrent guesses pass `checkLoginRateLimit` before any of them
	// recorded the attempt, multiplying brute-force bandwidth by the
	// concurrency level. On successful authentication we refund the IP
	// and email buckets via clearLoginAttempts; the global bucket stays.
	checkAndRecordLoginAttempt(ip, email);

	// Two-step flow: when mfaToken is present we trust the prior password
	// proof embedded in its HMAC and skip re-verifying the password — both
	// to spare a bcrypt and to avoid re-reading credentials the client may
	// have wiped from its form. The challenge is short-lived (5 min).
	if (mfaToken) {
		const challenge = verifyMfaChallenge(mfaToken);
		if (!challenge) {
			throw error(401, 'Invalid email or password');
		}
		// Collapse "MFA code missing" and "MFA code wrong" into the same
		// canonical credential error so the response shape doesn't tell
		// an attacker which step failed.
		if (!mfaCode || !verifyMfaCode(challenge.userId, mfaCode)) {
			throw error(401, 'Invalid email or password');
		}
		// Re-load the user so we have current name/email for the session
		// reply (the challenge token only carries userId).
		const user = await verifyPassword(email, password);
		if (!user || user.id !== challenge.userId) {
			throw error(401, 'Invalid email or password');
		}
		// Burn the challenge nonce now that step-2 fully succeeded. A
		// concurrent duplicate request that loses this consume race gets
		// false and 401, which prevents a stolen-after-success replay
		// from creating a second session. Legitimate retries on a wrong
		// TOTP code don't reach this line.
		if (!consumeMfaChallenge(mfaToken)) {
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
