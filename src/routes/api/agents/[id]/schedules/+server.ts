import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { notFound, parseJsonBody, pickPresentKeys, requireUser, translateServiceError } from '$lib/server/request-utils.js';
import { createScheduleSchema, updateScheduleSchema } from '$lib/validators-rmm.js';
import { ServiceError } from '$lib/server/service-error.js';
import { getAgent } from '$services/agents.js';
import {
	listSchedules,
	createSchedule,
	updateSchedule,
	toggleSchedule,
	deleteSchedule,
	getSchedule
} from '$services/agent-schedules.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	if (!getAgent(params.id)) throw notFound();
	return json(listSchedules(params.id));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);
	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	const body = await parseJsonBody(request) as Record<string, unknown>;
	const action = typeof body.action === 'string' ? body.action : '';

	switch (action) {
		case 'update': {
			const id = typeof body.id === 'string' ? body.id : '';
			const existing = id ? getSchedule(id) : null;
			if (!existing || existing.agentId !== agent.id) throw notFound();
			const parsed = updateScheduleSchema.safeParse(body);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			const safeData = pickPresentKeys(parsed.data, body);
			try {
				return json(updateSchedule(id, safeData, locals.user.id));
			} catch (e) {
				if (e instanceof ServiceError) return translateServiceError(e);
				throw e;
			}
		}
		case 'toggle': {
			const id = typeof body.id === 'string' ? body.id : '';
			const enabled = typeof body.enabled === 'boolean' ? body.enabled : false;
			const existing = id ? getSchedule(id) : null;
			if (!existing || existing.agentId !== agent.id) throw notFound();
			return json(toggleSchedule(id, enabled, locals.user.id));
		}
		case 'delete': {
			const id = typeof body.id === 'string' ? body.id : '';
			const existing = id ? getSchedule(id) : null;
			if (!existing || existing.agentId !== agent.id) throw notFound();
			deleteSchedule(id, locals.user.id);
			return json({ ok: true });
		}
		default: {
			const parsed = createScheduleSchema.safeParse(body);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			try {
				return json(createSchedule({
					agentId: agent.id,
					...parsed.data
				}, locals.user.id), { status: 201 });
			} catch (e) {
				if (e instanceof ServiceError) return translateServiceError(e);
				throw e;
			}
		}
	}
};
