import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, requireUser } from '$lib/server/request-utils.js';
import { getSession, getToolExecution, approveToolExecution } from '$services/ai-session.js';
import { resolveApproval } from '$lib/server/ai/approval-map.js';

export const POST: RequestHandler = ({ request, params, locals }) =>
	handleActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			decide: async (data, userId) => {
				const sessionId = String(params.id);
				const s = getSession(sessionId);
				if (!s || s.userId !== userId) throw error(404, 'session not found');
				const executionId = typeof data.executionId === 'string' ? data.executionId : '';
				const decision = data.decision === 'approved' || data.decision === 'rejected' ? data.decision : null;
				if (!executionId || !decision) throw error(400, 'executionId and decision required');

				const exec = getToolExecution(executionId);
				if (!exec || exec.sessionId !== sessionId) throw error(404, 'execution not found');
				if (exec.status !== 'pending') throw error(409, `execution is ${exec.status}`);

				if (!approveToolExecution(executionId, decision, userId)) {
					throw error(409, 'execution already resolved');
				}
				resolveApproval(executionId, decision);
				return json({ ok: true, decision });
			}
		}
	});
