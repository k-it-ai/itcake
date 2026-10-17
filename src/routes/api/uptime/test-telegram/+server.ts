import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser } from '#lib/server/request-utils.js';
import { testTelegram } from '#services/monitor-notifications.js';
import { getSetting } from '#lib/server/db.js';
import { TELEGRAM_BOT_TOKEN_RE } from '#lib/validators-settings.js';
import { SETTINGS_MASK } from '#services/settings.js';
import type { UptimeSettings } from '#lib/types.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	const body = await parseJsonBody(request);
	let { botToken, chatId } = body as { botToken?: string; chatId?: string };

	if (!botToken || !chatId) throw error(400, 'Missing botToken or chatId');

	if (botToken === SETTINGS_MASK) {
		const existing = getSetting<UptimeSettings>('uptime');
		botToken = existing?.telegram?.botToken ?? '';
		if (!botToken) throw error(400, 'No bot token configured');
	}

	if (!TELEGRAM_BOT_TOKEN_RE.test(botToken)) throw error(400, 'Invalid bot token format');

	const result = await testTelegram(botToken, chatId);
	return json(result);
};
