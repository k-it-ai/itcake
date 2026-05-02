import { describe, it, expect } from 'vitest';
import {
	clientSchema,
	invoiceSchema,
	proposalSchema,
	expenseSchema,
	generalSettingsSchema,
	ticketSchema,
	updateTicketSchema,
	updateInvoiceSchema,
	updateProposalSchema,
	companySettingsSchema,
	monitorSchema,
	loginSchema,
	registerSchema
} from '../../src/lib/validators.js';


describe('language field validation', () => {
	function parseClientLang(lang: string) {
		return clientSchema.safeParse({
			name: 'Test', email: 'test@example.com',
			address: { street: 'St', city: 'City', zip: '12345', country: 'DE' },
			language: lang
		});
	}

	it('accepts two-letter lowercase language codes', () => {
		expect(parseClientLang('de').success).toBe(true);
		expect(parseClientLang('en').success).toBe(true);
		expect(parseClientLang('fr').success).toBe(true);
	});

	it('accepts language-REGION format', () => {
		expect(parseClientLang('en-US').success).toBe(true);
		expect(parseClientLang('de-AT').success).toBe(true);
		expect(parseClientLang('pt-BR').success).toBe(true);
	});

	it('rejects uppercase language codes', () => {
		expect(parseClientLang('DE').success).toBe(false);
		expect(parseClientLang('EN').success).toBe(false);
	});

	it('rejects lowercase region codes', () => {
		expect(parseClientLang('en-us').success).toBe(false);
	});

	it('rejects arbitrary strings (injection attempts)', () => {
		expect(parseClientLang("'; DROP TABLE--").success).toBe(false);
		expect(parseClientLang('../../../etc/passwd').success).toBe(false);
		expect(parseClientLang('x'.repeat(100)).success).toBe(false);
		expect(parseClientLang('').success).toBe(false);
		expect(parseClientLang('12').success).toBe(false);
		expect(parseClientLang('eng').success).toBe(false);
	});

	it('rejects language with extra suffixes', () => {
		expect(parseClientLang('en-US-extra').success).toBe(false);
	});

	it('validates language on invoice schema', () => {
		const result = invoiceSchema.safeParse({
			clientId: 'c1', issueDate: '2026-01-01', dueDate: '2026-01-31',
			items: [{ id: '1', quantity: 1, unitPrice: 1000, taxRate: 19 }],
			language: "'; DROP TABLE--"
		});
		expect(result.success).toBe(false);
	});

	it('validates language on proposal schema', () => {
		const result = proposalSchema.safeParse({
			clientId: 'c1', issueDate: '2026-01-01', validUntil: '2026-01-31',
			items: [{ id: '1', quantity: 1, unitPrice: 1000, taxRate: 19 }],
			language: '../etc/passwd'
		});
		expect(result.success).toBe(false);
	});
});


describe('currency field validation', () => {
	function parseClientCurrency(currency: string) {
		return clientSchema.safeParse({
			name: 'Test', email: 'test@example.com',
			address: { street: 'St', city: 'City', zip: '12345', country: 'DE' },
			currency
		});
	}

	it('accepts valid ISO 4217 currency codes', () => {
		expect(parseClientCurrency('EUR').success).toBe(true);
		expect(parseClientCurrency('USD').success).toBe(true);
		expect(parseClientCurrency('GBP').success).toBe(true);
		expect(parseClientCurrency('CHF').success).toBe(true);
	});

	it('rejects lowercase currency codes', () => {
		expect(parseClientCurrency('eur').success).toBe(false);
		expect(parseClientCurrency('usd').success).toBe(false);
	});

	it('rejects wrong-length currency codes', () => {
		expect(parseClientCurrency('EU').success).toBe(false);
		expect(parseClientCurrency('EURO').success).toBe(false);
		expect(parseClientCurrency('').success).toBe(false);
	});

	it('rejects injection attempts in currency', () => {
		expect(parseClientCurrency("EUR' OR '1'='1").success).toBe(false);
		expect(parseClientCurrency('<script>').success).toBe(false);
	});

	it('validates currency on expense schema', () => {
		const result = expenseSchema.safeParse({
			date: '2026-01-01', description: 'Office supplies',
			amount: 5000, currency: 'invalid!'
		});
		expect(result.success).toBe(false);
	});
});


describe('general settings language enum', () => {
	it('accepts en and de', () => {
		const base = { currency: 'EUR', dateFormat: 'YYYY-MM-DD', timezone: 'Europe/Berlin' };
		expect(generalSettingsSchema.safeParse({ ...base, language: 'en' }).success).toBe(true);
		expect(generalSettingsSchema.safeParse({ ...base, language: 'de' }).success).toBe(true);
	});

	it('rejects unsupported languages', () => {
		const base = { currency: 'EUR', dateFormat: 'YYYY-MM-DD', timezone: 'Europe/Berlin' };
		expect(generalSettingsSchema.safeParse({ ...base, language: 'fr' }).success).toBe(false);
		expect(generalSettingsSchema.safeParse({ ...base, language: '' }).success).toBe(false);
		expect(generalSettingsSchema.safeParse({ ...base, language: 'EN' }).success).toBe(false);
	});
});


describe('template option key validation', () => {
	function parseInvoiceWithOptions(options: Record<string, unknown>) {
		return invoiceSchema.safeParse({
			clientId: 'c1', issueDate: '2026-01-01', dueDate: '2026-01-31',
			items: [{ id: '1', quantity: 1, unitPrice: 1000, taxRate: 19 }],
			templateOptions: options
		});
	}

	it('accepts valid identifier keys', () => {
		expect(parseInvoiceWithOptions({ accentColor: '#ff0000' }).success).toBe(true);
		expect(parseInvoiceWithOptions({ showLogo: true }).success).toBe(true);
		expect(parseInvoiceWithOptions({ fontSize_px: 14 }).success).toBe(true);
	});

	it('rejects __proto__ key (prototype pollution)', () => {
		const result = parseInvoiceWithOptions({ _proto: 'test' });
		expect(result.success).toBe(false);
	});

	it('rejects constructor key (prototype chain traversal)', () => {
		const badKeys = [
			{ '': 'empty' },
			{ '123abc': 'starts with number' },
			{ 'a b': 'contains space' },
			{ 'a.b': 'contains dot' },
			{ 'a-b': 'contains dash' },
		];
		for (const obj of badKeys) {
			const result = parseInvoiceWithOptions(obj);
			expect(result.success).toBe(false);
		}
	});

	it('rejects keys exceeding max length', () => {
		const result = parseInvoiceWithOptions({ ['a'.repeat(101)]: 'too long' });
		expect(result.success).toBe(false);
	});

	it('limits total number of template options', () => {
		const manyOptions: Record<string, string> = {};
		for (let i = 0; i < 51; i++) {
			manyOptions[`option${i}`] = 'value';
		}
		const result = parseInvoiceWithOptions(manyOptions);
		expect(result.success).toBe(false);
	});
});


describe('ticket schema', () => {
	it('accepts valid ticket data', () => {
		const result = ticketSchema.safeParse({
			clientId: 'c1', date: '2026-01-15', startTime: '09:00',
			hours: 2.5, hourlyRate: 8500
		});
		expect(result.success).toBe(true);
	});

	it('requires clientId', () => {
		const result = ticketSchema.safeParse({
			date: '2026-01-15', startTime: '09:00', hours: 2.5, hourlyRate: 8500
		});
		expect(result.success).toBe(false);
	});

	it('rejects invalid time format', () => {
		const result = ticketSchema.safeParse({
			clientId: 'c1', date: '2026-01-15', startTime: '25:00',
			hours: 2.5, hourlyRate: 8500
		});
		expect(result.success).toBe(false);
	});

	it('rejects zero hours', () => {
		const result = ticketSchema.safeParse({
			clientId: 'c1', date: '2026-01-15', startTime: '09:00',
			hours: 0, hourlyRate: 8500
		});
		expect(result.success).toBe(false);
	});

	it('update schema allows partial data', () => {
		const result = updateTicketSchema.safeParse({ hours: 3 });
		expect(result.success).toBe(true);
	});

	it('update schema validates provided fields', () => {
		const result = updateTicketSchema.safeParse({ hours: -1 });
		expect(result.success).toBe(false);
	});
});

describe('updateInvoiceSchema strips status + paidDate', () => {
	it('does not surface status on parse output', () => {
		const r = updateInvoiceSchema.safeParse({ notes: 'x', status: 'paid' });
		expect(r.success).toBe(true);
		if (r.success) {
			expect((r.data as Record<string, unknown>).status).toBeUndefined();
			expect((r.data as Record<string, unknown>).notes).toBe('x');
		}
	});

	it('does not surface paidDate on parse output', () => {
		const r = updateInvoiceSchema.safeParse({ notes: 'x', paidDate: '2026-01-01' });
		expect(r.success).toBe(true);
		if (r.success) {
			expect((r.data as Record<string, unknown>).paidDate).toBeUndefined();
		}
	});
});

describe('updateProposalSchema strips status', () => {
	it('does not surface status on parse output', () => {
		const r = updateProposalSchema.safeParse({ notes: 'x', status: 'accepted' });
		expect(r.success).toBe(true);
		if (r.success) {
			expect((r.data as Record<string, unknown>).status).toBeUndefined();
			expect((r.data as Record<string, unknown>).notes).toBe('x');
		}
	});
});


const minClient = (extra: Record<string, unknown> = {}) => ({
	name: 'Acme', email: 'a@b.co',
	address: { street: 'Main 1', city: 'Berlin', zip: '10115', country: 'DE' },
	...extra
});

const minCompany = (extra: Record<string, unknown> = {}) => ({
	name: 'Acme', email: '', phone: '', website: '', taxNumber: '', vatNumber: '',
	registrationNumber: '', address: { country: 'NL' }, logoUrl: '',
	bankName: '', bankAccount: '', bankIban: '', bankSwift: '', legalInfo: '', ...extra
});

describe('website URL scheme allowlist', () => {
	it('clientSchema accepts empty website', () => {
		expect(clientSchema.safeParse(minClient({ website: '' })).success).toBe(true);
	});
	it('clientSchema accepts http://', () => {
		expect(clientSchema.safeParse(minClient({ website: 'http://example.com' })).success).toBe(true);
	});
	it('clientSchema accepts https://', () => {
		expect(clientSchema.safeParse(minClient({ website: 'https://example.com' })).success).toBe(true);
	});
	it('clientSchema rejects javascript:', () => {
		expect(clientSchema.safeParse(minClient({ website: 'javascript:alert(1)' })).success).toBe(false);
	});
	it('clientSchema rejects data:', () => {
		expect(clientSchema.safeParse(minClient({ website: 'data:text/html,<script>alert(1)</script>' })).success).toBe(false);
	});
	it('clientSchema rejects bare hostname (no scheme)', () => {
		expect(clientSchema.safeParse(minClient({ website: 'example.com' })).success).toBe(false);
	});
	it('companySettingsSchema rejects javascript:', () => {
		expect(companySettingsSchema.safeParse(minCompany({ website: 'javascript:alert(1)' })).success).toBe(false);
	});
});

describe('monitorSchema.domain — label-strict regex', () => {
	const base = { checks: { ping: true, http: false, domainExpiry: false, sslExpiry: false } };
	it('accepts example.com', () => {
		expect(monitorSchema.safeParse({ name: 'M', domain: 'example.com', ...base }).success).toBe(true);
	});
	it('accepts deep.sub.example.co.uk', () => {
		expect(monitorSchema.safeParse({ name: 'M', domain: 'deep.sub.example.co.uk', ...base }).success).toBe(true);
	});
	it('rejects "...com" (consecutive dots)', () => {
		expect(monitorSchema.safeParse({ name: 'M', domain: '...com', ...base }).success).toBe(false);
	});
	it('rejects leading dot', () => {
		expect(monitorSchema.safeParse({ name: 'M', domain: '.example.com', ...base }).success).toBe(false);
	});
	it('rejects trailing dot', () => {
		expect(monitorSchema.safeParse({ name: 'M', domain: 'example.com.', ...base }).success).toBe(false);
	});
	it('rejects label starting with hyphen', () => {
		expect(monitorSchema.safeParse({ name: 'M', domain: '-bad.example.com', ...base }).success).toBe(false);
	});
});

describe('email length cap (RFC 5321: 254 chars max)', () => {
	const longLocal = 'a'.repeat(250) + '@b.co'; // 256 chars
	it('loginSchema rejects 256-char email', () => {
		expect(loginSchema.safeParse({ email: longLocal, password: 'pw' }).success).toBe(false);
	});
	it('registerSchema rejects 256-char email', () => {
		expect(registerSchema.safeParse({
			email: longLocal, name: 'X', password: 'Abcdefg1'
		}).success).toBe(false);
	});
});
