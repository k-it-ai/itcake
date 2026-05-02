import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	handleActionPost,
	notFound,
	parseUpdateBody,
	requireId,
	requireUser
} from '$lib/server/request-utils.js';
import { createScheduleSchema, updateScheduleSchema } from '$lib/validators-rmm.js';
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

export const POST: RequestHandler = ({ params, request, locals }) => {
	requireUser(locals);
	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	const ownsSchedule = (scheduleId: string): boolean => {
		const existing = getSchedule(scheduleId);
		return !!existing && existing.agentId === agent.id;
	};

	return handleActionPost(request, locals, {
		create: (data, userId) => {
			const parsed = createScheduleSchema.safeParse(data);
			if (!parsed.success) throw error(400, parsed.error.issues[0].message);
			return json(createSchedule({ agentId: agent.id, ...parsed.data }, userId), { status: 201 });
		},
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				if (!ownsSchedule(id)) throw notFound();
				const { id: _, ...rest } = data;
				const safe = parseUpdateBody(updateScheduleSchema, rest);
				return json(updateSchedule(id, safe, userId));
			},
			toggle: (data, userId) => {
				const id = requireId(data);
				if (!ownsSchedule(id)) throw notFound();
				const enabled = typeof data.enabled === 'boolean' ? data.enabled : false;
				return json(toggleSchedule(id, enabled, userId));
			},
			delete: (data, userId) => {
				const id = requireId(data);
				if (!ownsSchedule(id)) throw notFound();
				deleteSchedule(id, userId);
				return json({ ok: true });
			}
		}
	});
};
