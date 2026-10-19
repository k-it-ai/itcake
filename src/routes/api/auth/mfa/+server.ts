import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser, translateServiceError } from '#lib/server/request-utils.js';
import { mfaInitSchema, mfaEnableSchema, mfaDisableSchema } from '#lib/validators-auth.js';
import { ServiceError } from '#lib/server/service-error.js';
import { getMfaStatus, initMfa, enableMfa, disableMfa } from '#services/auth-mfa.js';
import { checkAndRecordAttempt, checkAndRecordAttemptResponse } from '#lib/server/rate-limit.js';
import { requireMfaStepUp } from '#lib/server/mfa-step-up.js';
import { verifyUserPassword } from '#lib/server/auth.js';

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

	const resp = checkAndRecordAttemptResponse(`mfa:${locals.user.id}`, 10, 'Too many MFA changes');
	if (resp) return resp;

	switch (action) {
		case 'init': {
			const parsed = mfaInitSchema.safeParse(body);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			if (!await verifyUserPassword(locals.user.id, parsed.data.currentPassword)) {
				throw error(403, 'Current password incorrect');
			}
			return json(initMfa(locals.user.email));
		}
		case 'enable': {
			const parsed = mfaEnableSchema.safeParse(body);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			if (!await verifyUserPassword(locals.user.id, parsed.data.currentPassword)) {
				throw error(403, 'Current password incorrect');
			}
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
			if (!await verifyUserPassword(locals.user.id, parsed.data.currentPassword)) {
				throw error(403, 'Current password incorrect');
			}
			requireMfaStepUp(locals.user.id, { mfaCode: parsed.data.code }, 'MFA disable');
			try {
				disableMfa(locals.user.id);
			} catch (e) {
				if (e instanceof ServiceError) return translateServiceError(e);
				throw e;
			}
			cookies.delete('itcake_session', { path: '/' });
			return json({ ok: true, sessionRevoked: true });
		}
	}
};
