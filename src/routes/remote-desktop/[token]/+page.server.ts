import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { exchangeForGuacToken } from '$services/guacamole.js';
import { peekRemoteSession } from '$services/remote-sessions.js';
import { requireUser } from '$lib/server/request-utils.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	requireUser(locals, 'Authentication required');

	const peek = peekRemoteSession(params.token);
	if (!peek) throw error(404, 'Session token invalid or expired');
	if (peek.userId !== locals.user.id) throw error(403, 'Session token does not belong to you');
	if (peek.consumedAt) throw error(409, 'Session token already used');

	const exchange = exchangeForGuacToken(params.token);
	if (!exchange) throw error(409, 'Session token already used');

	return {
		guacToken: exchange.guacToken,
		sessionId: exchange.sessionId,
		protocol: peek.protocol,
		maxSessionMinutes: exchange.maxSessionMinutes
	};
};
