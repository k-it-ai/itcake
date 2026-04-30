import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { loginSchema } from '$lib/validators.js';
import { verifyPassword, createSession, getUserById } from '$lib/server/auth.js';
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

	// Two-step flow: the mfaToken HMAC is the proof that step-1 (password)
	// succeeded for `challenge.userId`. We don't re-run bcrypt — that would
	// burn ~100ms per request and would 401 a legitimate operator whose
	// frontend cleared the password field between the two POSTs. The
	// userId baked into the HMAC + the single-use nonce on the
	// `mfa_used_challenges` table are what authorise the session here.
	if (mfaToken) {
		const challenge = verifyMfaChallenge(mfaToken);
		if (!challenge) throw error(401, 'Invalid email or password');
		// Collapse "MFA code missing" and "MFA code wrong" into the same
		// canonical credential error so the response shape doesn't tell
		// an attacker which step failed.
		if (!mfaCode || !verifyMfaCode(challenge.userId, mfaCode)) {
			throw error(401, 'Invalid email or password');
		}
		const user = getUserById(challenge.userId);
		if (!user) throw error(401, 'Invalid email or password');
		// Burn the challenge nonce now that step-2 fully succeeded. A
		// concurrent duplicate request that loses this consume race gets
		// false and 401, preventing a stolen-after-success replay from
		// creating a second session. Legitimate retries on a wrong TOTP
		// code don't reach this line.
		if (!consumeMfaChallenge(mfaToken)) throw error(401, 'Invalid email or password');
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
