import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	handleAdminActionPost,
	notFound,
	parseUpdateBody,
	requireId,
	requireAdmin
} from '#lib/server/request-utils.js';
import { updateAgentSchema } from '#lib/validators-rmm.js';
import { getAgents, updateAgent, updateAgentAutoUpdate, deleteAgent, queryAgentsFiltered } from '#services/agents.js';
import { getSavedFilter } from '#services/saved-filters.js';
import type { FilterCondition } from '#lib/server/filter-engine.js';
import { z } from 'zod';

const autoUpdateSchema = z.object({
	autoUpdateSoftware: z.boolean().optional(),
	autoUpdateOS: z.boolean().optional(),
	autoUpdateIntervalHours: z.number().int().min(1).max(720).optional()
});

const inlineFilterSchema = z.array(z.object({
	field: z.string().min(1).max(100).regex(/^[a-zA-Z][a-zA-Z0-9_.]*$/),
	operator: z.string().min(1).max(40),
	value: z.unknown().optional()
})).max(50);

export const GET: RequestHandler = async ({ locals, url }) => {
	requireAdmin(locals);
	const savedFilterId = url.searchParams.get('filter');
	const inlineQ = url.searchParams.get('q');

	if (savedFilterId) {
		const saved = getSavedFilter(savedFilterId);
		if (!saved) throw error(404, 'Saved filter not found');
		if (saved.appliesTo !== 'agent') throw error(400, 'Saved filter does not apply to agents');
		try {
			return json(queryAgentsFiltered(saved.conditions as FilterCondition[]));
		} catch (e) {
			throw error(400, e instanceof Error ? e.message : 'invalid filter');
		}
	}

	if (inlineQ) {
		let parsed: unknown;
		try { parsed = JSON.parse(inlineQ); }
		catch { throw error(400, 'Invalid JSON in q parameter'); }
		const r = inlineFilterSchema.safeParse(parsed);
		if (!r.success) throw error(400, r.error.issues[0]?.message ?? 'Invalid filter');
		try {
			return json(queryAgentsFiltered(r.data as FilterCondition[]));
		} catch (e) {
			throw error(400, e instanceof Error ? e.message : 'invalid filter');
		}
	}

	return json(getAgents());
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleAdminActionPost(request, locals, {
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
