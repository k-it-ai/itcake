import type { LayoutServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getAllSettings } from '$services/settings.js';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const settings = getAllSettings();

	// Strip SMTP password — never send credentials to the browser
	// Expose hasSmtpPass flag so the UI can show a placeholder indicator
	const hasSmtpPass = !!(settings.emails?.smtp?.pass);
	if (settings.emails?.smtp) {
		settings.emails = {
			...settings.emails,
			smtp: { ...settings.emails.smtp, pass: '' }
		};
	}

	return {
		user: locals.user,
		settings,
		hasSmtpPass
	};
};
