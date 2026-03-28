import { z } from 'zod';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParseFormat);

// --- Shared schemas ---

/** Validates an ISO date string (YYYY-MM-DD) strictly — rejects impossible dates like Feb 31. */
const dateString = z.string().min(1)
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (expected YYYY-MM-DD)')
	.refine((v) => dayjs(v, 'YYYY-MM-DD', true).isValid(), { message: 'Invalid date value' });

export const addressSchema = z.object({
	street: z.string().max(500).default(''),
	city: z.string().max(200).default(''),
	zip: z.string().max(100).default(''),
	state: z.string().max(200).default(''),
	country: z.string().refine((v) => v === '' || v.length === 2, { message: 'Country code must be 2 characters' }).default('')
});

const lineItemBaseSchema = z.object({
	id: z.string().max(200),
	name: z.string().max(200).default(''),
	description: z.string().max(5000).default(''),
	quantity: z.number().finite().min(-1_000_000).max(1_000_000), // negative allowed for credit notes
	unit: z.string().max(100).default(''),
	unitPrice: z.number().int().finite().min(-100_000_000_00).max(100_000_000_00), // cents, ±1B
	taxRate: z.number().finite().min(0).max(100)
});

// Recursive line item schema
export type LineItemInput = z.output<typeof lineItemBaseSchema> & {
	items: LineItemInput[];
};

export const lineItemSchema: z.ZodType<LineItemInput> = lineItemBaseSchema.extend({
	items: z.lazy(() => lineItemSchema.array().max(20)).default([])
}).refine(
	// Guard against integer overflow: quantity * unitPrice must stay within Number.MAX_SAFE_INTEGER.
	// Applied here (not on base schema) because .refine() produces ZodEffects which can't be .extend()'d.
	(item) => Math.abs(item.quantity * item.unitPrice) <= Number.MAX_SAFE_INTEGER,
	{ message: 'Line item total exceeds safe calculation range', path: ['unitPrice'] }
) as z.ZodType<LineItemInput>;

/** Max recursion depth for line items — must match MAX_NESTING_DEPTH in money.ts */
const MAX_ITEM_DEPTH = 10;

function checkItemDepth(items: LineItemInput[], depth = 0): boolean {
	if (depth > MAX_ITEM_DEPTH) return false;
	return items.every(item => !item.items?.length || checkItemDepth(item.items, depth + 1));
}

export const discountSchema = z.object({
	type: z.enum(['percentage', 'fixed']),
	value: z.number().finite().min(0).max(100_000_000_00), // cents, max 1B
	description: z.string().max(5000).default('')
}).refine((d) => d.type !== 'percentage' || d.value <= 100, {
	message: 'Percentage discount cannot exceed 100%'
}).refine((d) => d.type !== 'fixed' || Number.isInteger(d.value), {
	message: 'Fixed discount value must be a whole number (cents)'
});

// --- Client ---

const clientAddressSchema = z.object({
	street: z.string().min(1, 'Street is required').max(500),
	city: z.string().min(1, 'City is required').max(200),
	zip: z.string().min(1, 'ZIP code is required').max(100),
	state: z.string().max(200).default(''),
	country: z.string().length(2, 'Country is required')
});

export const clientSchema = z.object({
	clientNumber: z.string().max(100).default(''),
	name: z.string().min(1, 'Client name is required').max(200),
	email: z.string().min(1, 'Email is required').email(),
	phone: z.string().max(100).default(''),
	website: z.string().max(500).default(''),
	vatNumber: z.string().max(100).default(''),
	registrationNumber: z.string().max(100).default(''),
	address: clientAddressSchema,
	notes: z.string().max(5000).default(''),
	contactPerson: z.string().max(200).default(''),
	language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).max(10).default('de'),
	currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
	paymentTermDays: z.number().int().min(0).default(30)
});

// --- Recurring config (embedded in invoices) ---

export const recurringConfigSchema = z.object({
	enabled: z.boolean(),
	frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly', 'custom']),
	customIntervalDays: z.number().int().min(1).max(730).nullable().default(null),
	nextRunDate: dateString,
	endDate: dateString.nullable().default(null),
	lastRunDate: dateString.nullable().default(null),
	generatedInvoiceIds: z.array(z.string().max(200)).max(100).default([])
});

// --- Invoice ---

export const invoiceSchema = z.object({
	invoiceType: z.enum(['invoice', 'creditNote']).default('invoice'),
	linkedInvoiceId: z.string().max(200).nullable().default(null),
	clientId: z.string().min(1).max(200),
	status: z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']).default('draft'),
	pricingMode: z.enum(['net', 'gross']).default('net'),
	currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
	language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).max(10).default('de'),
	issueDate: dateString,
	dueDate: dateString,
	paidDate: dateString.nullable().default(null),
	items: z.array(lineItemSchema).min(1, 'At least one item is required').max(200),
	discounts: z.array(discountSchema).max(50).default([]),
	notes: z.string().max(5000).default(''),
	footerText: z.string().max(5000).default(''),
	templateId: z.string().max(200).default('plain'),
	templateOptions: z.record(
		z.string().max(100).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Template option key must be a valid identifier'),
		z.union([z.string().max(500), z.number().finite(), z.boolean()])
	).refine(
		(obj) => Object.keys(obj).length <= 50,
		{ message: 'Too many template options (max 50)' }
	).default({}),
	recurring: recurringConfigSchema.nullable().default(null)
});

// Create-specific schema: omits server-generated fields
// Enforces non-negative quantities for regular invoices (credit notes allow negative)
export const createInvoiceSchema = invoiceSchema.omit({
	status: true,
	paidDate: true
}).refine(
	(data) => data.invoiceType === 'creditNote' || data.items.every(function checkPositive(item): boolean {
		return item.quantity >= 0 && item.items.every(checkPositive);
	}),
	{ message: 'Quantity must be non-negative for regular invoices', path: ['items'] }
).refine(
	(data) => data.dueDate >= data.issueDate,
	{ message: 'Due date must not be before issue date', path: ['dueDate'] }
).refine(
	(data) => checkItemDepth(data.items),
	{ message: `Line items cannot be nested more than ${MAX_ITEM_DEPTH} levels deep`, path: ['items'] }
);

// Update-specific schema: all fields optional, but items must have at least 1 if provided
// NOTE: The credit note quantity check skips when invoiceType is absent (partial update).
// The service layer handles this — it preserves the existing invoiceType and doesn't allow
// changing it post-creation, so negative quantities in items are only accepted when the
// caller explicitly sends invoiceType: 'creditNote'.
export const updateInvoiceSchema = invoiceSchema.partial().refine(
	(data) => !data.items || data.items.length >= 1,
	{ message: 'At least one item is required', path: ['items'] }
).refine(
	(data) => !data.items || checkItemDepth(data.items),
	{ message: `Line items cannot be nested more than ${MAX_ITEM_DEPTH} levels deep`, path: ['items'] }
).refine(
	(data) => !data.dueDate || !data.issueDate || data.dueDate >= data.issueDate,
	{ message: 'Due date must not be before issue date', path: ['dueDate'] }
).refine(
	// Skip negative-quantity check when invoiceType is not provided — the service layer
	// uses the existing document's type. When invoiceType IS provided and is not creditNote,
	// enforce non-negative quantities.
	(data) => !data.items || !data.invoiceType || data.invoiceType === 'creditNote' || data.items.every(function checkPositive(item): boolean {
		return item.quantity >= 0 && item.items.every(checkPositive);
	}),
	{ message: 'Quantity must be non-negative for regular invoices', path: ['items'] }
);

// --- Proposal ---

export const proposalSchema = z.object({
	clientId: z.string().min(1).max(200),
	status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']).default('draft'),
	pricingMode: z.enum(['net', 'gross']).default('net'),
	currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
	language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).max(10).default('de'),
	issueDate: dateString,
	validUntil: dateString,
	items: z.array(lineItemSchema).min(1).max(200),
	discounts: z.array(discountSchema).max(50).default([]),
	introText: z.string().max(5000).default(''),
	notes: z.string().max(5000).default(''),
	footerText: z.string().max(5000).default(''),
	templateId: z.string().max(200).default('plain'),
	templateOptions: z.record(
		z.string().max(100).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Template option key must be a valid identifier'),
		z.union([z.string().max(500), z.number().finite(), z.boolean()])
	).refine(
		(obj) => Object.keys(obj).length <= 50,
		{ message: 'Too many template options (max 50)' }
	).default({})
});

// Create-specific schema: omits server-generated fields, validates business rules
export const createProposalSchema = proposalSchema.omit({
	status: true
}).refine(
	(data) => data.items.every(function checkPositive(item): boolean {
		return item.quantity >= 0 && item.items.every(checkPositive);
	}),
	{ message: 'Quantity must be non-negative for proposals', path: ['items'] }
).refine(
	(data) => data.validUntil >= data.issueDate,
	{ message: 'Valid-until date must not be before issue date', path: ['validUntil'] }
).refine(
	(data) => checkItemDepth(data.items),
	{ message: `Line items cannot be nested more than ${MAX_ITEM_DEPTH} levels deep`, path: ['items'] }
);

// Update-specific schema: all fields optional, but items must have at least 1 if provided
export const updateProposalSchema = proposalSchema.partial().refine(
	(data) => !data.items || data.items.length >= 1,
	{ message: 'At least one item is required', path: ['items'] }
).refine(
	(data) => !data.items || checkItemDepth(data.items),
	{ message: `Line items cannot be nested more than ${MAX_ITEM_DEPTH} levels deep`, path: ['items'] }
).refine(
	(data) => !data.validUntil || !data.issueDate || data.validUntil >= data.issueDate,
	{ message: 'Valid-until date must not be before issue date', path: ['validUntil'] }
);

// --- Unit ---

export const unitSchema = z.object({
	name: z.string().min(1, 'Unit name is required').max(200)
});

// --- Catalog Item ---

export const catalogItemSchema = z.object({
	name: z.string().min(1, 'Name is required').max(200),
	description: z.string().max(5000).default(''),
	unitPrice: z.number().int().min(0).max(100_000_000_00), // cents, max 1B
	unit: z.string().max(100).default(''),
	taxRate: z.number().finite().min(0).max(100).default(0)
});

// --- Expense ---

export const expenseSchema = z.object({
	date: dateString,
	description: z.string().min(1, 'Description is required').max(5000),
	amount: z.number().int().min(0).max(100_000_000_00), // cents, max 1B
	taxAmount: z.number().int().min(0).max(100_000_000_00).default(0), // cents, max 1B
	currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
	category: z.enum(['office', 'travel', 'software', 'equipment', 'marketing', 'professional', 'insurance', 'utilities', 'other']).default('other'),
	vendor: z.string().max(200).default(''),
	notes: z.string().max(5000).default('')
}).refine(
	(data) => data.taxAmount <= data.amount,
	{ message: 'Tax amount cannot exceed total amount', path: ['taxAmount'] }
);

// --- Settings ---

export const generalSettingsSchema = z.object({
	language: z.enum(['en', 'de']),
	currency: z.string().regex(/^[A-Z]{3}$/).max(3),
	dateFormat: z.string().max(100),
	timezone: z.string().max(100)
});

export const companySettingsSchema = z.object({
	name: z.string().max(200),
	email: z.string().max(500).email().or(z.literal('')),
	phone: z.string().max(100),
	website: z.string().max(500),
	taxNumber: z.string().max(100),
	vatNumber: z.string().max(100),
	registrationNumber: z.string().max(100),
	address: addressSchema,
	logoUrl: z.string().max(500).refine((v) => !v || v.startsWith('/api/logo'), { message: 'Invalid logo URL' }),
	bankName: z.string().max(200),
	bankAccount: z.string().max(200),
	bankIban: z.string().max(200),
	bankSwift: z.string().max(200),
	legalInfo: z.string().max(5000)
});

export const invoiceSettingsSchema = z.object({
	idFormat: z.string().max(100),
	nextNumber: z.number().int().min(1).max(9_999_999),
	defaultTemplate: z.string().max(200),
	defaultNotes: z.string().max(5000),
	defaultFooter: z.string().max(5000),
	defaultPricingMode: z.enum(['net', 'gross']),
	defaultTaxRate: z.number().finite().min(0).max(100),
	defaultPaymentTermDays: z.number().int().min(0).max(730)
});

export const proposalSettingsSchema = z.object({
	idFormat: z.string().max(100),
	nextNumber: z.number().int().min(1).max(9_999_999),
	defaultTemplate: z.string().max(200),
	defaultNotes: z.string().max(5000),
	defaultFooter: z.string().max(5000),
	defaultPricingMode: z.enum(['net', 'gross']),
	defaultTaxRate: z.number().finite().min(0).max(100),
	defaultValidDays: z.number().int().min(0).max(730)
});

export const smtpConfigSchema = z.object({
	host: z.string().max(500),
	port: z.number().int().min(1).max(65535),
	secure: z.boolean(),
	user: z.string().max(500),
	pass: z.string().max(500).nullable(), // null = keep existing, empty string = clear
	from: z.string().max(500),
	fromName: z.string().max(200)
});

const emailTemplateSchema = z.object({
	subject: z.string().max(500),
	body: z.string().max(50000)
});

export const emailSettingsSchema = z.object({
	smtp: smtpConfigSchema,
	invoiceEmail: emailTemplateSchema,
	creditNoteEmail: emailTemplateSchema,
	proposalEmail: emailTemplateSchema,
	reminderEmail: emailTemplateSchema
});

export const advancedSettingsSchema = z.object({
	sepaQrEnabled: z.boolean(),
	kleinunternehmer: z.boolean(),
	editLock: z.enum(['none', 'paid', 'sent']).default('none')
});

// --- Ticket ---

const timeString = z.string()
	.regex(/^\d{2}:\d{2}$/, 'Invalid time format (expected HH:mm)')
	.refine(v => {
		const [h, m] = v.split(':').map(Number);
		return h >= 0 && h <= 23 && m >= 0 && m <= 59;
	}, { message: 'Invalid time value' });

export const ticketSchema = z.object({
	title: z.string().max(200).default(''),
	description: z.string().max(5000).default(''),
	clientId: z.string().min(1).max(200),
	date: dateString,
	startTime: timeString,
	hours: z.number().finite().min(0.01).max(24),
	hourlyRate: z.number().int().min(0).max(100_000_000_00), // cents, max 1B
	notes: z.string().max(5000).default(''),
});

export const updateTicketSchema = ticketSchema.partial();

// --- Monitor ---

export const monitorSchema = z.object({
	name: z.string().min(1).max(200).regex(/^[^\r\n\0]+$/, 'Name must not contain newlines'),
	ip: z.string().max(500).default('').refine(
		v => v === '' || /^(\d{1,3}\.){3}\d{1,3}$/.test(v) || /^[0-9a-fA-F:]+$/.test(v),
		{ message: 'Must be a valid IPv4 or IPv6 address' }
	),
	domain: z.string().max(500).default('').refine(
		v => v === '' || (/^[a-zA-Z0-9.\-]+$/.test(v) && v.includes('.') && !/^(\d{1,3}\.){3}\d{1,3}$/.test(v)),
		{ message: 'Must be a valid domain name' }
	),
	enabled: z.boolean().default(true),
	checks: z.object({
		ping: z.boolean().default(false),
		http: z.boolean().default(false),
		domainExpiry: z.boolean().default(false),
		sslExpiry: z.boolean().default(false),
	}),
	httpExpectedStatus: z.number().int().min(100).max(599).default(200),
	domainExpiryThresholdDays: z.number().int().min(1).max(365).default(30),
	sslExpiryThresholdDays: z.number().int().min(1).max(365).default(14),
}).superRefine((data, ctx) => {
	if (!data.ip && !data.domain) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one of IP or domain is required', path: ['ip'] });
	}
	if ((data.checks.domainExpiry || data.checks.sslExpiry) && !data.domain) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Domain is required for expiry checks', path: ['domain'] });
	}
	if (!data.checks.ping && !data.checks.http && !data.checks.domainExpiry && !data.checks.sslExpiry) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one check type must be enabled', path: ['checks'] });
	}
});

export const uptimeSettingsSchema = z.object({
	telegram: z.object({
		botToken: z.string().max(200).default('').refine(
			v => v === '' || /^\d+:[A-Za-z0-9_-]{35}$/.test(v),
			{ message: 'Invalid Telegram bot token format (expected "123456:ABC-DEF...")' }
		),
		chatId: z.string().max(200).default('').refine(
			v => v === '' || /^-?\d+$/.test(v),
			{ message: 'Chat ID must be a numeric value' }
		),
		enabled: z.boolean().default(false),
	}),
	emailAlerts: z.boolean().default(false),
	alertEmail: z.string().max(300).refine(v => v === '' || z.string().email().safeParse(v).success, { message: 'Invalid email address' }).default(''),
});

// --- Auth ---

export const loginSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1).max(72) // bcryptjs silently truncates at 72 bytes
});

const passwordField = z.string().min(8, 'Password must be at least 8 characters').max(72)
	.refine(p => /[a-z]/.test(p), { message: 'Password must include a lowercase letter' })
	.refine(p => /[A-Z]/.test(p), { message: 'Password must include an uppercase letter' })
	.refine(p => /[0-9]/.test(p), { message: 'Password must include a number' });

export const registerSchema = z.object({
	email: z.string().email(),
	name: z.string().min(1).max(200),
	password: passwordField
});

export const changePasswordSchema = z.object({
	currentPassword: z.string().min(1, 'Current password is required').max(72),
	newPassword: passwordField
});

// --- Email sending ---

export const sendEmailSchema = z.object({
	to: z.string().email(),
	cc: z.string().max(2000).refine(
		(v) => !v || v.split(',').every((s) => s.trim() !== '' && z.string().email().safeParse(s.trim()).success),
		{ message: 'CC must be comma-separated email addresses' }
	).optional(),
	bcc: z.string().max(2000).refine(
		(v) => !v || v.split(',').every((s) => s.trim() !== '' && z.string().email().safeParse(s.trim()).success),
		{ message: 'BCC must be comma-separated email addresses' }
	).optional(),
	subject: z.string().min(1).max(500),
	body: z.string().min(1).max(50000),
	attachmentId: z.string().max(200).optional(),
	attachmentType: z.enum(['invoice', 'proposal']).optional()
});
