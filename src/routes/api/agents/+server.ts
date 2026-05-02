import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	handleActionPost,
	notFound,
	parseUpdateBody,
	requireId,
	requireUser
} from '$lib/server/request-utils.js';
import { updateAgentSchema } from '$lib/validators-rmm.js';
import { getAgents, updateAgent, updateAgentAutoUpdate, deleteAgent } from '$services/agents.js';
import { z } from 'zod';

const autoUpdateSchema = z.object({
	autoUpdateSoftware: z.boolean().optional(),
	autoUpdateOS: z.boolean().optional(),
	autoUpdateIntervalHours: z.number().int().min(1).max(720).optional()
});

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	return json(getAgents());
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: () => {
			throw error(400, 'Agents are enrolled via /api/rmm/enroll, not created via this endpoint');
		},
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				const { id: _, ...rest } = data;
				const safe = parseUpdateBody(updateAgentSchema, rest);
				const updated = updateAgent(id, safe, userId);
				if (!updated) throw notFound();
				return json(updated);
			},
			autoUpdate: (data, userId) => {
				const id = requireId(data);
				const { id: _, ...rest } = data;
				const safe = parseUpdateBody(autoUpdateSchema, rest);
				const updated = updateAgentAutoUpdate(id, safe, userId);
				if (!updated) throw notFound();
				return json(updated);
			},
			delete: (data, userId) => {
				const id = requireId(data);
				if (!deleteAgent(id, userId)) throw notFound();
				return json({ ok: true });
			}
		}
	});
