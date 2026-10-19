import type { LayoutServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getAllSettings } from '#services/settings.js';
import { requireAdmin } from '#lib/server/request-utils.js';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const settings = getAllSettings();

	const hasSmtpPass = !!(settings.emails?.smtp?.pass);
	if (settings.emails?.smtp) {
		settings.emails = {
			...settings.emails,
			smtp: { ...settings.emails.smtp, pass: '' }
		};
	}
	const hasTelegramToken = !!(settings.uptime?.telegram?.botToken);
	if (settings.uptime?.telegram) {
		settings.uptime = {
			...settings.uptime,
			telegram: { ...settings.uptime.telegram, botToken: '' }
		};
	}

	return {
		user: locals.user,
		settings,
		hasSmtpPass,
		hasTelegramToken
	};
};
