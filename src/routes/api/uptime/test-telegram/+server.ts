import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { testTelegram } from '$services/monitor-notifications.js';
import { getSetting } from '$lib/server/db.js';
import type { UptimeSettings } from '$lib/types.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	let { botToken, chatId } = body as { botToken?: string; chatId?: string };

	if (!botToken || !chatId) throw error(400, 'Missing botToken or chatId');

	// Validate bot token format to prevent SSRF via crafted token in fetch URL
	const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{35}$/;

	// If token is masked, use stored one
	if (botToken.includes('••••')) {
		const existing = getSetting<UptimeSettings>('uptime');
		botToken = existing?.telegram?.botToken ?? '';
		if (!botToken) throw error(400, 'No bot token configured');
	}

	if (!BOT_TOKEN_RE.test(botToken)) throw error(400, 'Invalid bot token format');

	const result = await testTelegram(botToken, chatId);
	return json(result);
};
