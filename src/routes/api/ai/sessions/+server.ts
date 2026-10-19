import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, requireUser } from '#lib/server/request-utils.js';
import { startSession, listSessions, AiNotConfiguredError } from '#services/ai-session.js';
import type { ApprovalMode } from '#lib/server/ai/types.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireUser(locals);
	const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
	return json(listSessions(locals.user!.id, limit));
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => {
			try {
				const title = typeof data.title === 'string' ? data.title : undefined;
				const pageContext = (data.pageContext && typeof data.pageContext === 'object') ? data.pageContext as Record<string, unknown> : undefined;
				const approvalMode = typeof data.approvalMode === 'string'
					&& ['per_step', 'auto_approve_safe', 'plan'].includes(data.approvalMode)
					? data.approvalMode as ApprovalMode
					: undefined;
				return json(startSession(userId, { title, pageContext, approvalMode }));
			} catch (e) {
				if (e instanceof AiNotConfiguredError) throw error(400, e.message);
				throw e;
			}
		}
	});
