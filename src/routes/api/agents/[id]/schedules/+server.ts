import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError, pickPresentKeys } from '$lib/server/request-utils.js';
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
	if (!locals.user) throw error(401);
	if (!getAgent(params.id)) throw error(404, 'Agent not found');
	return json(listSchedules(params.id));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401);
	const agent = getAgent(params.id);
	if (!agent) throw error(404, 'Agent not found');

	const body = await parseJsonBody(request) as Record<string, unknown>;
	const action = typeof body.action === 'string' ? body.action : '';

	switch (action) {
		case 'update': {
			const id = typeof body.id === 'string' ? body.id : '';
			const existing = id ? getSchedule(id) : null;
			if (!existing || existing.agentId !== agent.id) throw error(404, 'Schedule not found');
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
			if (!existing || existing.agentId !== agent.id) throw error(404, 'Schedule not found');
			return json(toggleSchedule(id, enabled, locals.user.id));
		}
		case 'delete': {
			const id = typeof body.id === 'string' ? body.id : '';
			const existing = id ? getSchedule(id) : null;
			if (!existing || existing.agentId !== agent.id) throw error(404, 'Schedule not found');
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
