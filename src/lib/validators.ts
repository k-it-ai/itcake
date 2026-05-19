import { z } from 'zod';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

// Avoids `node:net` so this validator stays usable client-side. The previous
// /^\d{1,3}\.{3}\d{1,3}$/ accepted `999.999.999.999`.
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const IPV6_RE = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}$|^(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}$|^(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}$/;

function isIPLiteral(v: string): boolean {
	return IPV4_RE.test(v) || IPV6_RE.test(v) || v === '::' || v === '::1';
}

dayjs.extend(customParseFormat);


const dateString = z.string().min(1)
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (expected YYYY-MM-DD)')
	.refine((v) => dayjs(v, 'YYYY-MM-DD', true).isValid(), { message: 'Invalid date value' });

export function httpUrlOrEmpty(v: string): boolean {
	if (!v) return true;
	try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; }
}

const lineItemBaseSchema = z.object({
	id: z.string().max(200),
	name: z.string().max(200).default(''),
	description: z.string().max(5000).default(''),
	quantity: z.number().finite().min(-1_000_000).max(1_000_000), // negative allowed for credit notes
	unit: z.string().max(100).default(''),
	unitPrice: z.number().int().finite().min(-100_000_000_00).max(100_000_000_00), // cents, ±1B
	taxRate: z.number().finite().min(0).max(100)
});

type LineItemInput = z.output<typeof lineItemBaseSchema> & {
	items: LineItemInput[];
};

const lineItemSchema: z.ZodType<LineItemInput> = lineItemBaseSchema.extend({
	items: z.lazy(() => lineItemSchema.array().max(20)).default([])
}).refine(
	// Guard against integer overflow: quantity * unitPrice must stay within Number.MAX_SAFE_INTEGER.
	(item) => Math.abs(item.quantity * item.unitPrice) <= Number.MAX_SAFE_INTEGER,
	{ message: 'Line item total exceeds safe calculation range', path: ['unitPrice'] }
) as z.ZodType<LineItemInput>;

/** Max recursion depth for line items — must match MAX_NESTING_DEPTH in money.ts */
const MAX_ITEM_DEPTH = 10;

function checkItemDepth(items: LineItemInput[], depth = 0): boolean {
	if (depth > MAX_ITEM_DEPTH) return false;
	return items.every(item => !item.items?.length || checkItemDepth(item.items, depth + 1));
}

const discountSchema = z.object({
	type: z.enum(['percentage', 'fixed']),
	value: z.number().finite().min(0).max(100_000_000_00), // cents, max 1B
	description: z.string().max(5000).default('')
}).refine((d) => d.type !== 'percentage' || d.value <= 100, {
	message: 'Percentage discount cannot exceed 100%'
}).refine((d) => d.type !== 'fixed' || Number.isInteger(d.value), {
	message: 'Fixed discount value must be a whole number (cents)'
});


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
	email: z.string().min(1, 'Email is required').max(254).email(),
	phone: z.string().max(100).default(''),
	website: z.string().max(500).refine(httpUrlOrEmpty, 'Website must be empty or http(s)://').default(''),
	vatNumber: z.string().max(100).default(''),
	registrationNumber: z.string().max(100).default(''),
	address: clientAddressSchema,
	notes: z.string().max(5000).default(''),
	contactPerson: z.string().max(200).default(''),
	language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).max(10).default('de'),
	currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
	paymentTermDays: z.number().int().min(0).default(30)
});


const recurringConfigSchema = z.object({
	enabled: z.boolean(),
	frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly', 'custom']),
	customIntervalDays: z.number().int().min(1).max(730).nullable().default(null),
	nextRunDate: dateString,
	endDate: dateString.nullable().default(null),
	lastRunDate: dateString.nullable().default(null),
	generatedInvoiceIds: z.array(z.string().max(200)).max(100).default([]),
	anchorDay: z.number().int().min(1).max(31).optional()
});


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
	// Must match DEFAULT_TEMPLATE_ID in services/templates.ts. Hard-coded
	// here instead of imported so this validator stays a pure schema (no
	// runtime dependency on the templates service).
	templateId: z.string().max(200).default('itcake'),
	templateOptions: z.record(
		z.string().max(100).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Template option key must be a valid identifier'),
		z.union([z.string().max(500), z.number().finite(), z.boolean()])
	).refine(
		(obj) => Object.keys(obj).length <= 50,
		{ message: 'Too many template options (max 50)' }
	).default({}),
	recurring: recurringConfigSchema.nullable().default(null)
});

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

// Update-specific schema: all fields optional, but items must have at least 1 if provided.
export const updateInvoiceSchema = invoiceSchema.omit({
	status: true,
	paidDate: true
}).partial().refine(
	(data) => !data.items || data.items.length >= 1,
	{ message: 'At least one item is required', path: ['items'] }
).refine(
	(data) => !data.items || checkItemDepth(data.items),
	{ message: `Line items cannot be nested more than ${MAX_ITEM_DEPTH} levels deep`, path: ['items'] }
).refine(
	(data) => !data.dueDate || !data.issueDate || data.dueDate >= data.issueDate,
	{ message: 'Due date must not be before issue date', path: ['dueDate'] }
).refine(
	(data) => !data.items || !data.invoiceType || data.invoiceType === 'creditNote' || data.items.every(function checkPositive(item): boolean {
		return item.quantity >= 0 && item.items.every(checkPositive);
	}),
	{ message: 'Quantity must be non-negative for regular invoices', path: ['items'] }
);


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
	// Must match DEFAULT_TEMPLATE_ID in services/templates.ts. Hard-coded
	// here instead of imported so this validator stays a pure schema (no
	// runtime dependency on the templates service).
	templateId: z.string().max(200).default('itcake'),
	templateOptions: z.record(
		z.string().max(100).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Template option key must be a valid identifier'),
		z.union([z.string().max(500), z.number().finite(), z.boolean()])
	).refine(
		(obj) => Object.keys(obj).length <= 50,
		{ message: 'Too many template options (max 50)' }
	).default({})
});

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

export const updateProposalSchema = proposalSchema.omit({
	status: true
}).partial().refine(
	(data) => !data.items || data.items.length >= 1,
	{ message: 'At least one item is required', path: ['items'] }
).refine(
	(data) => !data.items || checkItemDepth(data.items),
	{ message: `Line items cannot be nested more than ${MAX_ITEM_DEPTH} levels deep`, path: ['items'] }
).refine(
	(data) => !data.validUntil || !data.issueDate || data.validUntil >= data.issueDate,
	{ message: 'Valid-until date must not be before issue date', path: ['validUntil'] }
);


export const unitSchema = z.object({
	name: z.string().min(1, 'Unit name is required').max(200)
});


export const catalogItemSchema = z.object({
	name: z.string().min(1, 'Name is required').max(200),
	description: z.string().max(5000).default(''),
	unitPrice: z.number().int().min(0).max(100_000_000_00), // cents, max 1B
	unit: z.string().max(100).default(''),
	taxRate: z.number().finite().min(0).max(100).default(0)
});


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


export const monitorSchema = z.object({
	name: z.string().min(1).max(200).regex(/^[^\r\n\0]+$/, 'Name must not contain newlines'),
	ip: z.string().max(500).default('').refine(
		v => v === '' || isIPLiteral(v),
		{ message: 'Must be a valid IPv4 or IPv6 address' }
	),
	domain: z.string().max(253).default('').refine(
		v => v === '' || /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(v),
		{ message: 'Must be a valid domain name (e.g. example.com)' }
	),
	enabled: z.boolean().default(true),
	checks: z.object({
		ping: z.boolean().default(false),
		http: z.boolean().default(false),
		domainExpiry: z.boolean().default(false),
		sslExpiry: z.boolean().default(false),
	}).strict(),
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

export const sendEmailSchema = z.object({
	to: z.string().max(254).email(),
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
