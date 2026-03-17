import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { uptimeSettingsSchema } from '$lib/validators.js';
import { getSetting, setSetting } from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
import type { UptimeSettings } from '$lib/types.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
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
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	const result = uptimeSettingsSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	const existing = getSetting<UptimeSettings>('uptime');
	const data = result.data as UptimeSettings;

	// Preserve existing bot token if masked value sent back
	if (data.telegram.botToken.includes('••••')) {
		data.telegram.botToken = existing?.telegram?.botToken ?? '';
	}

	const diff = computeDiff(
		(existing ?? {}) as unknown as Record<string, unknown>,
		data as unknown as Record<string, unknown>
	);
	setSetting('uptime', data);
	if (Object.keys(diff).length > 0) {
		recordChange('settings', 'uptime', 'update', diff, locals.user.id);
	}

	return json({ ok: true });
};
