import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, isHttpError } from '@sveltejs/kit';
import { createFirstUserSafe, createSession, hasUsers } from '$lib/server/auth.js';
import { checkAndRecordSetupAttempt } from '$lib/server/rate-limit.js';
import { updateSettingsSection } from '$services/settings.js';
import { registerSchema } from '$lib/validators-auth.js';
import { companySettingsSchema, generalSettingsSchema } from '$lib/validators-settings.js';

export const load: PageServerLoad = async () => {
	if (hasUsers()) {
		throw redirect(302, '/login');
	}
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const ip = getClientAddress();
		try {
			checkAndRecordSetupAttempt(ip);
		} catch (e) {
			if (isHttpError(e) && e.status === 429) {
				return fail(429, { error: 'Too many attempts. Please try again later.' });
			}
			throw e;
		}

		const data = await request.formData();
		const rawName = data.get('name');
		const rawEmail = data.get('email');
		const rawPassword = data.get('password');

		if (typeof rawName !== 'string' || typeof rawEmail !== 'string' || typeof rawPassword !== 'string') {
			return fail(400, { error: 'Name, email, and password are required' });
		}

		const parsed = registerSchema.safeParse({
			name: rawName.slice(0, 200),
			email: rawEmail.slice(0, 500),
			password: rawPassword.slice(0, 72)
		});
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0].message });
		}
		const { name, email, password } = parsed.data;

		let userId: string;
		try {
			userId = await createFirstUserSafe(email, name, password);
		} catch (e: unknown) {
			if (e instanceof Error && e.message === 'REGISTRATION_CLOSED') {
				return fail(403, { error: 'Setup already completed' });
			}
			throw e;
		}
		createSession(userId, cookies);

		const cap = (s: string | null, max = 200) => (s || '').slice(0, max);

		const companyName = cap(data.get('companyName') as string);
		if (companyName) {
			const companyData = {
				name: companyName,
				email: cap(data.get('companyEmail') as string),
				phone: cap(data.get('companyPhone') as string, 50),
				taxNumber: cap(data.get('companyTaxNumber') as string, 50),
				vatNumber: cap(data.get('companyVat') as string, 50),
				address: {
					street: cap(data.get('companyStreet') as string),
					city: cap(data.get('companyCity') as string, 100),
					zip: cap(data.get('companyZip') as string, 20),
					state: '',
					country: cap(data.get('companyCountry') as string, 5) || 'NL'
				},
				bankName: cap(data.get('bankName') as string, 100),
				bankAccount: cap(data.get('bankAccount') as string, 50),
				bankIban: cap(data.get('bankIban') as string, 50),
				bankSwift: cap(data.get('bankSwift') as string, 20)
			};
			const companyParsed = companySettingsSchema.partial().safeParse(companyData);
			if (!companyParsed.success) {
				return fail(400, { error: companyParsed.error.issues[0].message });
			}
			updateSettingsSection('company', companyParsed.data, userId);
		}

		const generalData = {
			language: cap(data.get('language') as string, 10) || 'de',
			currency: cap(data.get('currency') as string, 10) || 'EUR',
			dateFormat: cap(data.get('dateFormat') as string, 20) || 'DD.MM.YYYY'
		};
		const generalParsed = generalSettingsSchema.partial().safeParse(generalData);
		if (!generalParsed.success) {
			return fail(400, { error: generalParsed.error.issues[0].message });
		}
		updateSettingsSection('general', generalParsed.data, userId);

		const rawTaxRate = parseFloat((data.get('defaultTaxRate') as string) || '21');
		const rawPaymentTermDays = parseInt((data.get('paymentTermDays') as string) || '30', 10);
		const defaultTaxRate = isNaN(rawTaxRate) ? 21 : Math.min(100, Math.max(0, rawTaxRate));
		const paymentTermDays = isNaN(rawPaymentTermDays) ? 30 : Math.min(730, Math.max(0, rawPaymentTermDays));
		updateSettingsSection('invoices', {
			defaultTaxRate,
			defaultPaymentTermDays: paymentTermDays
		}, userId);
		updateSettingsSection('proposals', {
			defaultTaxRate,
			defaultValidDays: paymentTermDays
		}, userId);

		throw redirect(302, '/dashboard');
	}
};
