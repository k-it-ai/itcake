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
	backupSettingsSchema,
	aiSettingsSchema
} from '$lib/validators.js';
import { remoteDesktopSettingsSchema } from '$lib/validators-rmm.js';
import { restartGuacamoleProxy } from '$services/guacamole.js';
import { resolveTarget } from '$lib/server/checks/validate-target.js';
import { ServiceError } from '$lib/server/service-error.js';
import type { EmailSettings, AiSettings } from '$lib/types.js';
import type { ZodSchema } from 'zod';

const sectionSchemas: Record<string, ZodSchema> = {
	general: generalSettingsSchema,
	company: companySettingsSchema,
	invoices: invoiceSettingsSchema,
	proposals: proposalSettingsSchema,
	emails: emailSettingsSchema,
	advanced: advancedSettingsSchema,
	backup: backupSettingsSchema,
	remoteDesktop: remoteDesktopSettingsSchema,
	ai: aiSettingsSchema
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
	if (settings.ai && typeof settings.ai === 'object') {
		const a = settings.ai as { apiKey?: string };
		if (a.apiKey) a.apiKey = '••••••••';
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
		const emailData = validatedData as { smtp?: { pass?: string | null; host?: string } };
		if (emailData.smtp) {
			const isMasked = typeof emailData.smtp.pass === 'string' && emailData.smtp.pass.includes('•');
			if (emailData.smtp.pass === null || isMasked) {
				const existing = getSetting<EmailSettings>('emails');
				emailData.smtp.pass = existing.smtp?.pass ?? '';
			}
		}
		if (emailData.smtp?.host) {
			try {
				await resolveTarget(emailData.smtp.host);
			} catch (e) {
				if (e instanceof ServiceError && e.i18nKey === 'error.targetBlockedIpRange') {
					throw error(400, `SMTP host resolves to a blocked IP range (private, loopback, link-local, or reserved): ${emailData.smtp.host}`);
				}
				if (e instanceof ServiceError && e.i18nKey === 'error.invalidHostname') {
					throw error(400, `Invalid SMTP hostname: ${emailData.smtp.host}`);
				}
				throw error(400, `Could not resolve SMTP host "${emailData.smtp.host}": ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	if (section === 'ai') {
		const aiData = validatedData as { apiKey?: string };
		const isMasked = typeof aiData.apiKey === 'string' && aiData.apiKey.includes('•');
		if (isMasked) {
			const existing = getSetting<AiSettings>('ai');
			aiData.apiKey = existing?.apiKey ?? '';
		}
	}

	if (section === 'remoteDesktop') {
		const rdData = validatedData as { guacdHost?: string };
		if (rdData.guacdHost) {
			const lc = rdData.guacdHost.trim().toLowerCase();
			if (lc !== '127.0.0.1' && lc !== '::1' && lc !== 'localhost') {
				try {
					await resolveTarget(rdData.guacdHost);
				} catch (e) {
					if (e instanceof ServiceError && e.i18nKey === 'error.targetBlockedIpRange') {
						throw error(400, `guacd host must be loopback (127.0.0.1, ::1, localhost) or a public hostname; refused blocked IP range: ${rdData.guacdHost}`);
					}
					if (e instanceof ServiceError && e.i18nKey === 'error.invalidHostname') {
						throw error(400, `Invalid guacd hostname: ${rdData.guacdHost}`);
					}
					throw error(400, `Could not resolve guacd host "${rdData.guacdHost}": ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		}
	}

	updateSettingsSection(section, validatedData, locals.user.id);

	if (section === 'remoteDesktop') {
		try { restartGuacamoleProxy(); } catch (e) { console.error('Guacamole proxy restart failed:', e instanceof Error ? e.message : e); }
	}

	return json({ ok: true });
};
