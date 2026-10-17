import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '#lib/server/request-utils.js';
import { registerSchema } from '#lib/validators-auth.js';
import { createFirstUserSafe, createSession, hasUsers } from '#lib/server/auth.js';
import { checkAndRecordSetupAttempt } from '#lib/server/rate-limit.js';
import { updateSettingsSection } from '#services/settings.js';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	checkAndRecordSetupAttempt(getClientAddress());

	if (hasUsers()) {
		throw error(403, 'Registration is disabled. A user already exists.');
	}

	const body = await parseJsonBody(request);
	const result = registerSchema.safeParse(body);

	if (!result.success) {
		throw error(400, 'Invalid request');
	}

	const { email, name, password, company } = result.data;

	try {
		const userId = await createFirstUserSafe(email, name, password);
		if (company) {
			updateSettingsSection('company', { name: company.name, email: company.email ?? email }, userId);
		}
		createSession(userId, cookies);
		return json({
			id: userId,
			email,
			name,
			...(company ? {} : { setupComplete: false, note: 'company info not provided; visit Settings → General to finish setup' })
		});
	} catch (e: unknown) {
		if (e instanceof Error && e.message === 'REGISTRATION_CLOSED') {
			throw error(403, 'Registration is disabled. A user already exists.');
		}
		if (e instanceof Error && ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message.includes('UNIQUE'))) {
			throw error(409, 'Email already registered');
		}
		throw e;
	}
};
