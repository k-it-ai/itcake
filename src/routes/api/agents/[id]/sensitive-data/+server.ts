import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleAdminActionPost, notFound, requireUser } from '#lib/server/request-utils.js';
import { getAgent } from '#services/agents.js';
import { dispatchCommand } from '#services/agent-commands.js';
import { listFindingsByCategory } from '#services/agent-findings.js';
import { validateScanScope } from '#services/sensitive-data.js';
import { LegacyEnrollmentError } from '#lib/server/agent-auth.js';
import { emitAgentEvent } from '#lib/server/agent-events.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const agent = getAgent(params.id);
	if (!agent) throw notFound();
	return json({
		findings: listFindingsByCategory(params.id, 'sensitive_data', 200)
	});
};

export const POST: RequestHandler = ({ params, request, locals }) =>
	handleAdminActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			scan: async (data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				if (!agent.enabled) throw error(400, 'Agent is disabled');
				if (agent.status === 'offline') throw error(400, 'Agent is offline');
				let scope;
				try {
					scope = validateScanScope(data.scope);
				} catch (e) {
					throw error(400, e instanceof Error ? e.message : 'Invalid scope');
				}
				try {
					const cmd = dispatchCommand(params.id, 'sensitive_data_scan', { scope }, userId, scope.timeoutSeconds + 30);
					emitAgentEvent();
					return json(cmd, { status: 201 });
				} catch (e) {
					if (e instanceof LegacyEnrollmentError) throw error(409, e.message);
					throw e;
				}
			}
		}
	});
