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

	const body = await parseJsonBody(request) as Record<string, unknown>;

	// Replace masked bot token with empty string before Zod validation —
	// the real token is preserved from existing settings below
	const tg = (body?.telegram ?? {}) as Record<string, unknown>;
	const isMasked = typeof tg.botToken === 'string' && tg.botToken.includes('\u2022');
	if (isMasked) tg.botToken = '';

	const result = uptimeSettingsSchema.safeParse(body);
	if (!result.success) throw error(400, result.error.issues[0].message);

	const existing = getSetting<UptimeSettings>('uptime');
	const data = result.data as UptimeSettings;

	// Preserve existing bot token if masked value was sent back
	if (isMasked) {
		data.telegram.botToken = existing?.telegram?.botToken ?? '';
	}

	const diff = computeDiff(
		(existing ?? {}) as unknown as Record<string, unknown>,
		data as unknown as Record<string, unknown>
	);
	// Mask bot token in audit log to prevent sensitive data in change history
	if (diff.telegram && typeof diff.telegram === 'object') {
		const d = diff.telegram as Record<string, unknown>;
		const mask = (v: unknown) => {
			if (v && typeof v === 'object' && 'botToken' in v) return { ...v, botToken: '***' };
			return v;
		};
		d.old = mask(d.old);
		d.new = mask(d.new);
	}
	setSetting('uptime', data);
	if (Object.keys(diff).length > 0) {
		recordChange('settings', 'uptime', 'update', diff, locals.user.id);
	}

	return json({ ok: true });
};
