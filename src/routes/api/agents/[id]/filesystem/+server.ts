import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, requireUser } from '$lib/server/request-utils.js';
import { getAgent } from '$services/agents.js';
import { dispatchCommand } from '$services/agent-commands.js';
import {
	validateFilesystemScope,
	filesystemCleanupSchema,
	getFilesystemSnapshot
} from '$services/filesystem.js';
import { requireMfaStepUp } from '$lib/server/mfa-step-up.js';
import { LegacyEnrollmentError } from '$lib/server/agent-auth.js';
import { emitAgentEvent } from '$lib/server/agent-events.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const agent = getAgent(params.id);
	if (!agent) throw notFound();
	const snap = getFilesystemSnapshot(params.id);
	return json({
		latestAnalysis: snap.latestAnalysis,
		findings: snap.findings
	});
};

export const POST: RequestHandler = ({ params, request, locals }) =>
	handleActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			scan: async (data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				if (!agent.enabled) throw error(400, 'Agent is disabled');
				if (agent.status === 'offline') throw error(400, 'Agent is offline');
				let scope;
				try {
					scope = validateFilesystemScope(data.scope);
				} catch (e) {
					throw error(400, e instanceof Error ? e.message : 'Invalid scope');
				}
				try {
					const cmd = dispatchCommand(params.id, 'filesystem_analysis', { scope }, userId, scope.timeoutSeconds + 30);
					emitAgentEvent();
					return json(cmd, { status: 201 });
				} catch (e) {
					if (e instanceof LegacyEnrollmentError) throw error(409, e.message);
					throw e;
				}
			},
			cleanup: async (data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				if (!agent.enabled) throw error(400, 'Agent is disabled');
				if (agent.status === 'offline') throw error(400, 'Agent is offline');

				requireMfaStepUp(userId, data, 'filesystem cleanup');

				const parsed = filesystemCleanupSchema.safeParse({ category: data.category, paths: data.paths });
				if (!parsed.success) throw error(400, parsed.error.issues.map(i => i.message).join(', '));
				try {
					const cmd = dispatchCommand(
						params.id,
						'filesystem_cleanup',
						{ category: parsed.data.category, paths: parsed.data.paths },
						userId,
						600
					);
					emitAgentEvent();
					return json(cmd, { status: 201 });
				} catch (e) {
					if (e instanceof LegacyEnrollmentError) throw error(409, e.message);
					throw e;
				}
			}
		}
	});
