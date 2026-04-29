import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser } from '$lib/server/request-utils.js';
import { uptimeSettingsSchema } from '$lib/validators.js';
import { getSetting } from '$lib/server/db.js';
import { updateSettingsSection } from '$services/settings.js';
import type { UptimeSettings } from '$lib/types.js';

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	const settings = getSetting<UptimeSettings>('uptime');
	// Return a copy with fully masked bot token — never mutate the parsed object
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
	requireUser(locals);

	const body = await parseJsonBody(request) as Record<string, unknown>;

	// Replace masked bot token with empty string before Zod validation —
	// the real token is preserved from existing settings below
	const tg = (body?.telegram ?? {}) as Record<string, unknown>;
	const isMasked = typeof tg.botToken === 'string' && tg.botToken.includes('\u2022');
	if (isMasked) tg.botToken = '';

	const result = uptimeSettingsSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	const data = result.data as UptimeSettings;

	// Preserve existing bot token if masked value was sent back
	if (isMasked) {
		const existing = getSetting<UptimeSettings>('uptime');
		data.telegram.botToken = existing?.telegram?.botToken ?? '';
	}

	// Use updateSettingsSection for deep-merge, audit logging with token masking
	updateSettingsSection('uptime', data, locals.user.id);

	return json({ ok: true });
};
