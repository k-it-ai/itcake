import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser } from '$lib/server/request-utils.js';
import { getAllSettings, updateSettingsSection } from '$services/settings.js';
import { getSetting } from '$lib/server/db.js';
import {
	generalSettingsSchema,
	companySettingsSchema,
	invoiceSettingsSchema,
	proposalSettingsSchema,
	emailSettingsSchema,
	advancedSettingsSchema,
	backupSettingsSchema
} from '$lib/validators.js';
import { remoteDesktopSettingsSchema } from '$lib/validators-rmm.js';
import { restartGuacamoleProxy } from '$services/guacamole.js';
import type { EmailSettings } from '$lib/types.js';
import type { ZodSchema } from 'zod';

const sectionSchemas: Record<string, ZodSchema> = {
	general: generalSettingsSchema,
	company: companySettingsSchema,
	invoices: invoiceSettingsSchema,
	proposals: proposalSettingsSchema,
	emails: emailSettingsSchema,
	advanced: advancedSettingsSchema,
	backup: backupSettingsSchema,
	remoteDesktop: remoteDesktopSettingsSchema
};

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	const settings = getAllSettings();
	if (settings.emails?.smtp) {
		settings.emails.smtp.pass = settings.emails.smtp.pass ? '••••••••' : '';
	}
	if (settings.uptime?.telegram) {
		settings.uptime.telegram.botToken = settings.uptime.telegram.botToken ? '••••••••' : '';
	}
	return json(settings);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	const body = await parseJsonBody(request);
	const { section, data } = body as { section: string; data: unknown };

	if (!section || data == null) {
		throw error(400, 'Missing section or data');
	}

	const schema = sectionSchemas[section];
	if (!schema) {
		throw error(400, 'Invalid settings section');
	}

	let validatedData: unknown = data;
	{
		const result = schema.safeParse(data);
		if (!result.success) throw error(400, result.error.issues[0].message);
		validatedData = result.data;
	}

	if (section === 'emails') {
		const emailData = validatedData as { smtp?: { pass?: string | null } };
		if (emailData.smtp && emailData.smtp.pass === null) {
			const existing = getSetting<EmailSettings>('emails');
			emailData.smtp.pass = existing.smtp?.pass ?? '';
		}
	}

	updateSettingsSection(section, validatedData, locals.user.id);

	if (section === 'remoteDesktop') {
		try { restartGuacamoleProxy(); } catch (e) { console.error('Guacamole proxy restart failed:', e instanceof Error ? e.message : e); }
	}

	return json({ ok: true });
};
