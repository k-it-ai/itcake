import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { notFound, parseJsonBody, pickPresentKeys, requireUser, translateServiceError } from '$lib/server/request-utils.js';
import { ServiceError } from '$lib/server/service-error.js';
import { createAlertRuleSchema, updateAlertRuleSchema } from '$lib/validators-rmm.js';
import {
	listAlertRules,
	createAlertRule,
	updateAlertRule,
	deleteAlertRule,
	getAlertRule
} from '$services/alerts.js';

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	return json(listAlertRules());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);
	const body = await parseJsonBody(request) as Record<string, unknown>;
	const action = typeof body.action === 'string' ? body.action : '';

	switch (action) {
		case 'update': {
			const id = typeof body.id === 'string' ? body.id : '';
			const existing = id ? getAlertRule(id) : null;
			if (!existing) throw notFound();
			const parsed = updateAlertRuleSchema.safeParse(body);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			const safeData = pickPresentKeys(parsed.data, body);
			try {
				return json(updateAlertRule(id, safeData, locals.user.id));
			} catch (e) {
				if (e instanceof ServiceError) return translateServiceError(e);
				throw e;
			}
		}
		case 'delete': {
			const id = typeof body.id === 'string' ? body.id : '';
			const existing = id ? getAlertRule(id) : null;
			if (!existing) throw notFound();
			deleteAlertRule(id, locals.user.id);
			return json({ ok: true });
		}
		default: {
			const parsed = createAlertRuleSchema.safeParse(body);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			try {
				return json(createAlertRule(parsed.data, locals.user.id), { status: 201 });
			} catch (e) {
				if (e instanceof ServiceError) return translateServiceError(e);
				throw e;
			}
		}
	}
};
