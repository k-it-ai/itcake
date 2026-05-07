import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, requireUser } from '$lib/server/request-utils.js';
import { getAgent } from '$services/agents.js';
import { dispatchCommand } from '$services/agent-commands.js';
import { getBootPerformanceTrend } from '$services/boot-performance.js';
import { LegacyEnrollmentError } from '$lib/server/agent-auth.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const agent = getAgent(params.id);
	if (!agent) throw notFound();
	return json(getBootPerformanceTrend(params.id));
};

export const POST: RequestHandler = ({ params, request, locals }) =>
	handleActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			collect: async (_data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				if (!agent.enabled) throw error(400, 'Agent is disabled');
				if (agent.status === 'offline') throw error(400, 'Agent is offline');
				try {
					const cmd = dispatchCommand(params.id, 'boot_performance_collect', {}, userId, 60);
					return json(cmd, { status: 201 });
				} catch (e) {
					if (e instanceof LegacyEnrollmentError) throw error(409, e.message);
					throw e;
				}
			}
		}
	});
