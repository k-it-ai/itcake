import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { getAllSettings, updateSettingsSection } from '$services/settings.js';
import {
	generalSettingsSchema,
	companySettingsSchema,
	invoiceSettingsSchema,
	proposalSettingsSchema,
	emailSettingsSchema,
	advancedSettingsSchema,
	backupSettingsSchema
} from '$lib/validators.js';
import type { ZodSchema } from 'zod';

const sectionSchemas: Record<string, ZodSchema> = {
	general: generalSettingsSchema,
	company: companySettingsSchema,
	invoices: invoiceSettingsSchema,
	proposals: proposalSettingsSchema,
	emails: emailSettingsSchema,
	advanced: advancedSettingsSchema,
	backup: backupSettingsSchema
};

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
	const settings = getAllSettings();
	// Strip secrets from response — they should never leave the server
	if (settings.emails?.smtp) {
		settings.emails.smtp.pass = settings.emails.smtp.pass ? '••••••••' : '';
	}
	if (settings.uptime?.telegram) {
		settings.uptime.telegram.botToken = settings.uptime.telegram.botToken ? '••••••••' : '';
	}
	return json(settings);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	const { section, data } = body as { section: string; data: unknown };

	if (!section || data == null) {
		throw error(400, 'Missing section or data');
	}

	// sectionSchemas is the single source of truth for valid sections
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

	// Preserve existing SMTP password unless explicitly changed.
	// null = "do not change" (sent by frontend when password is masked).
	// Empty string = intentionally clear the password.
	if (section === 'emails') {
		const emailData = validatedData as { smtp?: { pass?: string | null } };
		if (emailData.smtp && emailData.smtp.pass === null) {
			const existing = getAllSettings().emails;
			emailData.smtp.pass = existing.smtp?.pass ?? '';
		}
	}

	updateSettingsSection(section, validatedData, locals.user.id);

	return json({ ok: true });
};
