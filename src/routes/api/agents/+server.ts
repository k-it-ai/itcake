import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { notFound, parseJsonBody, requireUser } from '$lib/server/request-utils.js';
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

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	const body = await parseJsonBody(request);
	const { action, ...data } = body as { action?: string; [key: string]: unknown };

	if (action && !['update', 'delete', 'autoUpdate'].includes(action)) {
		throw error(400, 'Invalid action');
	}

	if (action === 'update') {
		const { id, ...updateData } = data as { id: string; [key: string]: unknown };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		const result = updateAgentSchema.safeParse(updateData);
		if (!result.success) throw error(400, result.error.issues[0].message);
		const updated = updateAgent(id, result.data, locals.user.id);
		if (!updated) throw notFound();
		return json(updated);
	}

	if (action === 'autoUpdate') {
		const { id, ...settingsData } = data as { id: string; [key: string]: unknown };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		const result = autoUpdateSchema.safeParse(settingsData);
		if (!result.success) throw error(400, result.error.issues[0].message);
		const updated = updateAgentAutoUpdate(id, result.data, locals.user.id);
		if (!updated) throw notFound();
		return json(updated);
	}

	if (action === 'delete') {
		const { id } = data as { id: string };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		if (!deleteAgent(id, locals.user.id)) throw notFound();
		return json({ ok: true });
	}

	throw error(400, 'Agents are enrolled via /api/rmm/enroll, not created via this endpoint');
};
