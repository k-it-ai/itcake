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

	const action = body.action;
	if (action !== 'init' && action !== 'enable' && action !== 'disable') {
		throw error(400, 'Unknown action');
	}

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
			cookies.delete('itcake_session', { path: '/' });
			return json({ ok: true, sessionRevoked: true });
		}
	}
};
