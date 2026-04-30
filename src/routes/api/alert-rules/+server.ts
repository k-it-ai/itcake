import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	handleActionPost,
	notFound,
	parseUpdateBody,
	requireId,
	requireUser
} from '$lib/server/request-utils.js';
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

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => {
			const parsed = createAlertRuleSchema.safeParse(data);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			return json(createAlertRule(parsed.data, userId), { status: 201 });
		},
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				if (!getAlertRule(id)) throw notFound();
				const { id: _, ...rest } = data;
				const safe = parseUpdateBody(updateAlertRuleSchema, rest);
				return json(updateAlertRule(id, safe, userId));
			},
			delete: (data, userId) => {
				const id = requireId(data);
				if (!getAlertRule(id)) throw notFound();
				deleteAlertRule(id, userId);
				return json({ ok: true });
			}
		}
	});
