import { z } from 'zod';
import { httpUrlOrEmpty } from './validators.js';

const addressSchema = z.object({
	street: z.string().max(500).default(''),
	city: z.string().max(200).default(''),
	zip: z.string().max(100).default(''),
	state: z.string().max(200).default(''),
	country: z.string().refine((v) => v === '' || v.length === 2, { message: 'Country code must be 2 characters' }).default('')
});

export const generalSettingsSchema = z.object({
	language: z.enum(['en', 'de']),
	currency: z.string().regex(/^[A-Z]{3}$/).max(3),
	dateFormat: z.string().max(100),
	timezone: z.string().max(100)
});

export const companySettingsSchema = z.object({
	name: z.string().max(200),
	email: z.string().max(254).email().or(z.literal('')),
	phone: z.string().max(100),
	website: z.string().max(500).refine(httpUrlOrEmpty, 'Website must be empty or http(s)://'),
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

const smtpConfigSchema = z.object({
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

const backupS3Schema = z.object({
	endpoint: z.string().max(500).default(''),
	region: z.string().max(100).default('us-east-1'),
	bucket: z.string().max(200).default(''),
	accessKeyId: z.string().max(200).default(''),
	secretAccessKey: z.string().max(2000).default(''),
	pathPrefix: z.string()
		.max(200)
		.refine(
			(s) => !s.split(/[\\/]/).some(seg => seg === '..'),
			{ message: 'pathPrefix must not contain ".." segments' }
		)
		.default('itcake/')
});

const backupWebdavSchema = z.object({
	url: z.string().max(500).default(''),
	username: z.string().max(200).default(''),
	password: z.string().max(2000).default('')
});

export const backupSettingsSchema = z.object({
	encryptionPassphrase: z.string().max(2000).default(''),
	offsite: z.object({
		enabled: z.boolean().default(false),
		schedule: z.enum(['daily', 'weekly', 'manual']).default('daily'),
		target: z.enum(['s3', 'webdav']).default('s3'),
		s3: backupS3Schema,
		webdav: backupWebdavSchema,
		retentionDays: z.number().int().min(1).max(3650).default(30)
	}).transform((o) => {
		const cleaned = { ...o } as Record<string, unknown>;
		delete cleaned.lastUpload;
		return cleaned as typeof o;
	})
});

export const TELEGRAM_BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

export const uptimeSettingsSchema = z.object({
	telegram: z.object({
		botToken: z.string().max(200).default('').refine(
			v => v === '' || TELEGRAM_BOT_TOKEN_RE.test(v),
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

export const telemetrySettingsSchema = z.object({
	errorReportingDsn: z.string().max(512).default(''),
	sampleRate: z.number().min(0).max(1).default(1)
}).strict();

export const aiSettingsSchema = z.object({
	enabled: z.boolean().default(false),
	apiKey: z.string().max(256).default(''),
	// Allowlist; anything else falls back to DEFAULT_PRICING in the cost
	// tracker. Keep in sync with MODEL_PRICING_CENTS_PER_MILLION_TOKENS.
	model: z.enum(['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']).default('claude-opus-4-7'),
	monthlyBudgetCents: z.number().int().min(0).max(10_000_000).default(5000),
	approvalMode: z.enum(['per_step', 'auto_approve_safe', 'plan']).default('per_step'),
	maxTurnsPerSession: z.number().int().min(1).max(500).default(50),
	maxOutputTokensPerTurn: z.number().int().min(256).max(64000).default(16000),
	thinkingMode: z.enum(['adaptive', 'disabled']).default('adaptive'),
	consultantMode: z.boolean().default(true)
}).strict();
