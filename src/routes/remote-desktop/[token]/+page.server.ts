import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { exchangeForGuacToken } from '$services/guacamole.js';
import { peekRemoteSession } from '$services/remote-sessions.js';

/**
 * Popup page server-load. Validates and consumes the session-token, then
 * mints the encrypted guac-token to embed in the rendered HTML.
 *
 * Single-use: `exchangeForGuacToken` calls `consumeRemoteSession`
 * atomically. We `peek` first to enforce ownership without burning
 * someone else's token — a forged URL pasted into the wrong operator's
 * browser yields 403 without consuming the row.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

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
