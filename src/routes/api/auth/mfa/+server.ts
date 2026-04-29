import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import bcrypt from 'bcryptjs';
import { db } from '$lib/server/db.js';
import { notFound, parseJsonBody, requireUser, translateServiceError } from '$lib/server/request-utils.js';
import { mfaInitSchema, mfaEnableSchema, mfaDisableSchema } from '$lib/validators.js';
import { ServiceError } from '$lib/server/service-error.js';
import { getMfaStatus, initMfa, enableMfa, disableMfa } from '$services/auth-mfa.js';
import { checkAndRecordAttempt } from '$lib/server/rate-limit.js';

const stmtGetUser = db.prepare('SELECT email, password_hash FROM users WHERE id = ?');

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	return json(getMfaStatus(locals.user.id));
};

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireUser(locals);

	const body = await parseJsonBody(request) as { action?: string };
	if (typeof body !== 'object' || body === null) throw error(400, 'Invalid body');

	// Reject unknown actions BEFORE charging the rate-limit bucket. The
	// previous order let an attacker (or a buggy client) DoS the legitimate
	// operator out of MFA management with 10 garbage `action: 'foo'`
	// requests in a 15-min window.
	const action = body.action;
	if (action !== 'init' && action !== 'enable' && action !== 'disable') {
		throw error(400, 'Unknown action');
	}

	// Per-user rate-limit on the sensitive verbs. Init is cheap (no
	// password) but exposes the secret if abused; enable/disable have
	// password checks. Cap to 10 attempts / 15 min — generous enough
	// for legitimate use, tight enough to deter brute-force on the
	// password leg.
	checkAndRecordAttempt(`mfa:${locals.user.id}`, 10, 'Too many MFA changes');

	switch (action) {
		case 'init': {
			const parsed = mfaInitSchema.safeParse(body);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			const userRow = stmtGetUser.get(locals.user.id) as { email: string; password_hash: string } | undefined;
			if (!userRow) throw notFound();
			const valid = await bcrypt.compare(parsed.data.currentPassword, userRow.password_hash);
			if (!valid) throw error(403, 'Current password incorrect');
			return json(initMfa(userRow.email));
		}
		case 'enable': {
			const parsed = mfaEnableSchema.safeParse(body);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			try {
				enableMfa(locals.user.id, parsed.data.secret, parsed.data.code, parsed.data.recoveryCodes);
			} catch (e) {
				if (e instanceof ServiceError) return translateServiceError(e);
				throw e;
			}
			// enableMfa just revoked the server-side sessions row; clear the
			// request's cookie so the operator's browser doesn't keep
			// presenting a now-orphaned token until the next page load.
			cookies.delete('itcake_session', { path: '/' });
			return json({ ok: true, sessionRevoked: true });
		}
		case 'disable': {
			const parsed = mfaDisableSchema.safeParse(body);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			try {
				await disableMfa(locals.user.id, parsed.data.currentPassword, parsed.data.code);
			} catch (e) {
				if (e instanceof ServiceError) return translateServiceError(e);
				throw e;
			}
			// disableMfa revoked all sessions server-side; mirror that on
			// the client so the operator re-authenticates immediately.
			cookies.delete('itcake_session', { path: '/' });
			return json({ ok: true, sessionRevoked: true });
		}
	}
};
