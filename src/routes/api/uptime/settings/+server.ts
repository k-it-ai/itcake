import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireAdmin } from '$lib/server/request-utils.js';
import { uptimeSettingsSchema } from '$lib/validators-settings.js';
import { getSetting } from '$lib/server/db.js';
import { updateSettingsSection } from '$services/settings.js';
import type { UptimeSettings } from '$lib/types.js';

export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	const settings = getSetting<UptimeSettings>('uptime');
	const masked = {
		...settings,
		telegram: {
			...settings?.telegram,
			botToken: settings?.telegram?.botToken ? '••••••••' : '',
		},
	};
	return json(masked);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals);

	const body = await parseJsonBody(request) as Record<string, unknown>;

	const tg = (body?.telegram ?? {}) as Record<string, unknown>;
	const isMasked = typeof tg.botToken === 'string' && tg.botToken.includes('\u2022');
	if (isMasked) tg.botToken = '';

	const result = uptimeSettingsSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	const data = result.data as UptimeSettings;

	if (isMasked) {
		const existing = getSetting<UptimeSettings>('uptime');
		data.telegram.botToken = existing?.telegram?.botToken ?? '';
	}

	updateSettingsSection('uptime', data, locals.user.id);

	return json({ ok: true });
};
