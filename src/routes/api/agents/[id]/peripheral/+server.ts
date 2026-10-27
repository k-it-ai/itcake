import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleAdminActionPost, notFound, requireAdmin } from '#lib/server/request-utils.js';
import { peripheralPolicySchema } from '#lib/validators-rmm.js';
import { getAgent } from '#services/agents.js';
import { getPolicy, setPolicy } from '#services/peripheral.js';
import { dispatchCommand } from '#services/agent-commands.js';
import { listFindingsByCategory } from '#services/agent-findings.js';
import { getLatestCollectorResult } from '#services/agent-collector-results.js';
import { LegacyEnrollmentError } from '#lib/server/agent-auth.js';
import { emitAgentEvent } from '#lib/server/agent-events.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals);
	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	return json({
		policy: getPolicy(params.id),
		latestInventory: getLatestCollectorResult(params.id, 'peripheral_inventory'),
		findings: listFindingsByCategory(params.id, 'peripheral', 100)
	});
};

export const POST: RequestHandler = ({ params, request, locals }) =>
	handleAdminActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			'set-policy': async (data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				const parsed = peripheralPolicySchema.safeParse(data.policy);
				if (!parsed.success) throw error(400, parsed.error.issues.map(i => i.message).join(', '));
				const policy = setPolicy(params.id, parsed.data, userId);
				return json(policy);
			},
			scan: async (_data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				if (!agent.enabled) throw error(400, 'Agent is disabled');
				if (agent.status === 'offline') throw error(400, 'Agent is offline');
				try {
					const cmd = dispatchCommand(params.id, 'peripheral_scan', {}, userId);
					emitAgentEvent();
					return json(cmd, { status: 201 });
				} catch (e) {
					if (e instanceof LegacyEnrollmentError) throw error(409, e.message);
					throw e;
				}
			}
		}
	});
