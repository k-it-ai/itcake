import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleAdminActionPost, requireAdmin } from '#lib/server/request-utils.js';
import { getAgent } from '#services/agents.js';
import { listFindingsByAgent, listFindingsByCategory, updateFindingState } from '#services/agent-findings.js';
import type { FindingCategory, FindingState } from '#lib/types.js';

const VALID_CATEGORIES: ReadonlySet<string> = new Set(['peripheral', 'sensitive_data', 'network', 'filesystem', 'policy']);
const VALID_STATES: ReadonlySet<string> = new Set(['open', 'resolved', 'accepted', 'false_positive']);

export const GET: RequestHandler = async ({ params, url, locals }) => {
	requireAdmin(locals);
	const agentId = String(params.id);
	if (!getAgent(agentId)) throw error(404, 'agent not found');
	const category = url.searchParams.get('category');
	const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '100')));
	if (category) {
		if (!VALID_CATEGORIES.has(category)) throw error(400, 'invalid category');
		return json(listFindingsByCategory(agentId, category as FindingCategory, limit));
	}
	return json(listFindingsByAgent(agentId, limit));
};

export const POST: RequestHandler = ({ request, params, locals }) =>
	handleAdminActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			'set-state': (data, userId) => {
				const agentId = String(params.id);
				if (!getAgent(agentId)) throw error(404, 'agent not found');
				const findingId = typeof data.findingId === 'string' ? data.findingId : '';
				const state = typeof data.state === 'string' ? data.state : '';
				if (!findingId) throw error(400, 'findingId required');
				if (!VALID_STATES.has(state)) throw error(400, 'invalid state');
				const updated = updateFindingState(findingId, state as FindingState, userId, agentId);
				if (!updated) throw error(404, 'finding not found');
				return json(updated);
			}
		}
	});
