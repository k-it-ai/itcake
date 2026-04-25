import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError } from '$lib/server/request-utils.js';
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
	if (!locals.user) throw error(401);
	return json(listAlertRules());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);
	const body = await parseJsonBody(request) as Record<string, unknown>;
	const action = typeof body.action === 'string' ? body.action : '';

	switch (action) {
		case 'update': {
			const id = typeof body.id === 'string' ? body.id : '';
			const existing = id ? getAlertRule(id) : null;
			if (!existing) throw error(404, 'Alert rule not found');
			const parsed = updateAlertRuleSchema.safeParse(body);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			try {
				return json(updateAlertRule(id, parsed.data, locals.user.id));
			} catch (e) {
				if (e instanceof ServiceError) return translateServiceError(e);
				throw e;
			}
		}
		case 'delete': {
			const id = typeof body.id === 'string' ? body.id : '';
			const existing = id ? getAlertRule(id) : null;
			if (!existing) throw error(404, 'Alert rule not found');
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
