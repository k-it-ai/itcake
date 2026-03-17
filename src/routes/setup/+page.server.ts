import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, isHttpError } from '@sveltejs/kit';
import { createFirstUserSafe, createSession, hasUsers } from '$lib/server/auth.js';
import { checkSetupRateLimit, recordSetupFailure } from '$lib/server/rate-limit.js';
import { updateSettingsSection } from '$services/settings.js';

export const load: PageServerLoad = async () => {
	if (hasUsers()) {
		throw redirect(302, '/login');
	}
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const ip = getClientAddress();
		try {
			checkSetupRateLimit(ip);
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
		const name = rawName.slice(0, 200);
		const email = rawEmail.slice(0, 500);
		const password = rawPassword.slice(0, 72);

		if (!name || !email || !password) {
			return fail(400, { error: 'Name, email, and password are required' });
		}

		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			recordSetupFailure(ip);
			return fail(400, { error: 'Please enter a valid email address' });
		}

		if (password.length < 8) {
			recordSetupFailure(ip);
			return fail(400, { error: 'Password must be at least 8 characters' });
		}

		// Atomically create the first user (race-safe)
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

		// Truncate helper — caps string length to match Zod schema .max() elsewhere
		const cap = (s: string | null, max = 200) => (s || '').slice(0, max);

		// Save company settings
		const companyName = cap(data.get('companyName') as string);
		if (companyName) {
			updateSettingsSection('company', {
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
			}, userId);
		}

		// Save general settings (language, currency, date format)
		const language = cap(data.get('language') as string, 10) || 'en';
		const currency = cap(data.get('currency') as string, 10) || 'EUR';
		const dateFormat = cap(data.get('dateFormat') as string, 20) || 'DD/MM/YYYY';
		updateSettingsSection('general', { language, currency, dateFormat }, userId);

		// Save invoice/proposal defaults
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
