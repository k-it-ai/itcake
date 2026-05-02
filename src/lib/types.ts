export interface Address {
	street: string;
	city: string;
	zip: string;
	state: string;
	country: string; // ISO 3166-1 alpha-2
}

export interface Client {
	id: string;
	clientNumber: string; // user-facing identifier (e.g. "C-001")
	name: string;
	email: string;
	phone: string;
	website: string;
	vatNumber: string;
	registrationNumber: string;
	address: Address;
	notes: string;
	contactPerson: string;
	language: string;
	currency: string;
	paymentTermDays: number;
	createdAt: string;
	updatedAt: string;
}

export interface LineItem {
	id: string;
	name: string; // headline (e.g. "IT-Support")
	description: string; // rich text details
	quantity: number;
	unit: string;
	unitPrice: number; // cents
	taxRate: number; // percentage, e.g. 21
	items: LineItem[]; // recursive sub-items
}

export interface Discount {
	type: 'percentage' | 'fixed';
	value: number; // percentage (0-100) or fixed amount in cents
	description: string;
}

export interface TaxSubtotal {
	rate: number;
	taxableAmount: number; // cents
	taxAmount: number; // cents
}

export interface InvoiceTotals {
	subtotal: number;
	discountAmount: number;
	subtotalAfterDiscounts: number;
	taxSubtotals: TaxSubtotal[];
	totalTaxes: number;
	total: number;
	netTotal: number;
	discountCapped: boolean;
}

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';
type InvoiceType = 'invoice' | 'creditNote';
export type PricingMode = 'net' | 'gross';

export interface Invoice {
	id: string;
	documentId: string; // formatted ID like "2026-0001"
	invoiceType: InvoiceType; // 'invoice' or 'creditNote'
	linkedInvoiceId: string | null; // reference to original invoice (for credit notes)
	clientId: string;
	status: InvoiceStatus;
	pricingMode: PricingMode;
	currency: string;
	language: string;
	issueDate: string;
	dueDate: string;
	paidDate: string | null;
	items: LineItem[];
	discounts: Discount[];
	notes: string;
	footerText: string;
	templateId: string;
	templateOptions: Record<string, unknown>;
	recurring: RecurringConfig | null;
	kleinunternehmer?: boolean; // §19 UStG snapshot — when true, no tax was charged
	seller: SellerInfo;
	buyer: BuyerInfo;
	totals: InvoiceTotals;
	sentAt: string | null;
	sentTo: string | null;
	createdAt: string;
	updatedAt: string;
}

export type ProposalStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';

export interface Proposal {
	id: string;
	documentId: string;
	clientId: string;
	status: ProposalStatus;
	pricingMode: PricingMode;
	currency: string;
	language: string;
	issueDate: string;
	validUntil: string;
	items: LineItem[];
	discounts: Discount[];
	introText: string;
	notes: string;
	footerText: string;
	templateId: string;
	templateOptions: Record<string, unknown>;
	kleinunternehmer?: boolean; // §19 UStG snapshot — when true, no tax was charged
	seller: SellerInfo;
	buyer: BuyerInfo;
	totals: InvoiceTotals;
	sentAt: string | null;
	sentTo: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface SellerInfo {
	name: string;
	email: string;
	phone: string;
	website: string;
	taxNumber: string;
	vatNumber: string;
	registrationNumber: string;
	address: Address;
	logoUrl: string;
	bankName: string;
	bankAccount: string;
	bankIban: string;
	bankSwift: string;
	legalInfo: string;
}

export interface BuyerInfo {
	name: string;
	email: string;
	phone: string;
	vatNumber: string;
	registrationNumber: string;
	contactPerson: string;
	address: Address;
}

export interface Unit {
	id: string;
	name: string;
	createdAt: string;
}

export interface CatalogItem {
	id: string;
	name: string;
	description: string;
	unitPrice: number; // cents
	unit: string;
	taxRate: number;
	createdAt: string;
	updatedAt: string;
}

export interface Template {
	id: string;
	name: string;
	builtIn: boolean;
	html: string;
	css: string;
	options: TemplateOption[];
	createdAt: string;
	updatedAt: string;
}

interface TemplateOption {
	key: string;
	label: string;
	type: 'color' | 'select' | 'boolean' | 'text' | 'font';
	default: string | boolean;
	options?: { label: string; value: string }[];
}

export interface EmailConfig {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	pass: string;
	from: string;
	fromName: string;
}

interface EmailTemplate {
	subject: string;
	body: string;
}

export interface Settings {
	general: GeneralSettings;
	company: CompanySettings;
	invoices: InvoiceSettings;
	proposals: ProposalSettings;
	emails: EmailSettings;
	advanced: AdvancedSettings;
	uptime?: UptimeSettings;
	rmm?: RmmSettings;
	backup?: BackupSettings;
	remoteDesktop?: RemoteDesktopSettings;
}

export type RemoteDesktopProtocol = 'rdp' | 'vnc' | 'ssh';

export interface AgentRemoteDesktop {
	protocol: RemoteDesktopProtocol;
	port: number;
	username: string;
	password: string;
	domain?: string;
	ignoreCert?: boolean;
	privateKey?: string;
	recording?: boolean;
}

export interface RemoteDesktopSettings {
	enabled: boolean;
	guacdHost: string;
	guacdPort: number;
	proxyPort: number;
	recordingEnabled: boolean;
	maxSessionMinutes: number;
	tokenTtlSeconds: number;
}

export interface RemoteSession {
	id: string;
	agentId: string;
	userId: string;
	protocol: RemoteDesktopProtocol;
	expiresAt: string;
	consumedAt: string | null;
	startedAt: string | null;
	endedAt: string | null;
	recordingPath: string | null;
	clientIp: string;
	userAgent: string;
	createdAt: string;
}

export interface BackupSettings {
	encryptionPassphrase: string;
	offsite: {
		enabled: boolean;
		schedule: 'daily' | 'weekly' | 'manual';
		target: 's3' | 'webdav';
		s3: {
			endpoint: string;
			region: string;
			bucket: string;
			accessKeyId: string;
			secretAccessKey: string;
			pathPrefix: string;
		};
		webdav: {
			url: string;
			username: string;
			password: string;
		};
		retentionDays: number;
		lastUpload: { at: string; ok: boolean; error?: string; sizeBytes?: number } | null;
	};
}

export interface GeneralSettings {
	language: string;
	currency: string;
	dateFormat: string;
	timezone: string;
}

export interface CompanySettings {
	name: string;
	email: string;
	phone: string;
	website: string;
	taxNumber: string;
	vatNumber: string;
	registrationNumber: string;
	address: Address;
	logoUrl: string;
	bankName: string;
	bankAccount: string;
	bankIban: string;
	bankSwift: string;
	legalInfo: string;
}

export interface InvoiceSettings {
	idFormat: string; // e.g. "{YYYY}-{####}"
	nextNumber: number;
	defaultTemplate: string;
	defaultNotes: string;
	defaultFooter: string;
	defaultPricingMode: PricingMode;
	defaultTaxRate: number;
	defaultPaymentTermDays: number;
}

export interface ProposalSettings {
	idFormat: string;
	nextNumber: number;
	defaultTemplate: string;
	defaultNotes: string;
	defaultFooter: string;
	defaultPricingMode: PricingMode;
	defaultTaxRate: number;
	defaultValidDays: number;
}

export interface EmailSettings {
	smtp: EmailConfig;
	invoiceEmail: EmailTemplate;
	creditNoteEmail: EmailTemplate;
	proposalEmail: EmailTemplate;
	reminderEmail: EmailTemplate;
}

type EditLockLevel = 'none' | 'paid' | 'sent';

export interface AdvancedSettings {
	sepaQrEnabled: boolean;
	kleinunternehmer: boolean; // §19 UStG — no tax charged
	editLock: EditLockLevel; // prevent editing invoices after reaching this status
}

export type RecurringFrequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';

export interface RecurringConfig {
	enabled: boolean;
	frequency: RecurringFrequency;
	customIntervalDays: number | null; // for 'custom' frequency
	nextRunDate: string; // ISO date (YYYY-MM-DD)
	endDate: string | null; // optional end date
	lastRunDate: string | null;
	generatedInvoiceIds: string[];
	anchorDay?: number;
}

export type TicketStatus = 'open' | 'completed' | 'invoiced';

export interface Ticket {
	id: string;
	ticketNumber: string;       // auto-generated (e.g. "T-001")
	title: string;              // optional line-item title (overrides default "IT-Support am/on {date}")
	description: string;        // rich HTML (RichTextArea)
	clientId: string;
	date: string;               // YYYY-MM-DD — date work was performed
	startTime: string;          // HH:mm — start time
	hours: number;              // decimal (e.g. 1.5 = 1h30m)
	hourlyRate: number;         // integer cents
	status: TicketStatus;
	invoiceId: string | null;   // linked invoice after conversion
	notes: string;              // internal, not exported to invoice
	createdAt: string;
	updatedAt: string;
}

export interface Change {
	id: string;
	entityType: 'invoice' | 'creditNote' | 'proposal' | 'client' | 'expense' | 'settings' | 'catalog_item' | 'unit' | 'template' | 'monitor' | 'ticket' | 'agent';
	entityId: string;
	action: 'create' | 'update' | 'delete' | 'status_change' | 'reopen' | 'send_email';
	diff: Record<string, { old: unknown; new: unknown }>;
	userId: string;
	createdAt: string;
}

export type ExpenseCategory = 'office' | 'travel' | 'software' | 'equipment' | 'marketing' | 'professional' | 'insurance' | 'utilities' | 'other';

export interface Expense {
	id: string;
	date: string; // YYYY-MM-DD
	description: string;
	amount: number; // integer cents
	taxAmount: number; // integer cents (input VAT / deductible)
	currency: string;
	category: ExpenseCategory;
	vendor: string;
	receiptFilename: string | null; // filename in uploads/receipts/
	notes: string;
	createdAt: string;
	updatedAt: string;
}

export type MonitorCheckType = 'ping' | 'http' | 'domain_expiry' | 'ssl_expiry';
export type MonitorStatus = 'up' | 'down' | 'error' | 'pending' | 'paused';

export interface Monitor {
	id: string;
	name: string;
	ip: string;
	domain: string;
	enabled: boolean;
	checks: {
		ping: boolean;
		http: boolean;
		domainExpiry: boolean;
		sslExpiry: boolean;
	};
	httpExpectedStatus: number;
	domainExpiryThresholdDays: number;
	sslExpiryThresholdDays: number;
	status: MonitorStatus;
	lastCheckedAt: string | null;
	lastResponseTimeMs: number | null;
	lastError: string | null;
	domainExpiryDate: string | null;
	sslExpiryDate: string | null;
	lastExpiryNotifiedDomain: number | null;
	lastExpiryNotifiedSsl: number | null;
	createdAt: string;
	updatedAt: string;
}

export interface MonitorCheck {
	id: string;
	monitorId: string;
	checkType: MonitorCheckType;
	status: 'up' | 'down' | 'error';
	responseTimeMs: number | null;
	message: string;
	checkedAt: string;
}

export interface MonitorDaily {
	monitorId: string;
	checkType: MonitorCheckType;
	date: string;
	uptimePercent: number;
	avgResponseMs: number | null;
	totalChecks: number;
	failedChecks: number;
}

export interface UptimeSettings {
	telegram: {
		botToken: string;
		chatId: string;
		enabled: boolean;
	};
	emailAlerts: boolean;
	alertEmail: string;
}

type AgentStatus = 'online' | 'offline' | 'pending' | 'stale';

export type AgentCommandType =
	| 'shell' | 'script'
	| 'package_update' | 'package_upgrade' | 'package_install' | 'package_uninstall'
	| 'software_update' | 'os_update' | 'check_os_updates'
	| 'service_action' | 'system_info_refresh' | 'reboot';

type AgentCommandStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface Agent {
	id: string;
	name: string;
	hostname: string;
	os: string;              // 'darwin' | 'linux' | 'windows'
	arch: string;            // 'amd64' | 'arm64'
	osVersion: string;
	agentVersion: string;
	hmacSecret?: string;
	monitorId: string | null;
	status: AgentStatus;
	enabled: boolean;
	lastSeenAt: string | null;
	ip: string;
	packageManagers: string[];
	cpuModel: string;
	autoUpdateSoftware: boolean;
	autoUpdateOS: boolean;
	autoUpdateIntervalHours: number;
	rebootRequired?: boolean;
	tags: string[];
	createdAt: string;
	updatedAt: string;
}

type AlertScope = 'agent_metric' | 'agent_offline' | 'agent_reboot_required' | 'monitor_status';

export type AlertCondition =
	| { kind: 'metric_threshold'; metric: 'cpu' | 'memory' | 'disk'; op: '>' | '>=' | '<' | '<='; value: number; durationMinutes?: number; tagAny?: string[] }
	| { kind: 'agent_offline'; durationMinutes: number; tagAny?: string[] }
	| { kind: 'agent_reboot_required'; tagAny?: string[] }
	| { kind: 'monitor_status'; status: 'down' | 'error'; monitorIds?: string[] };

export interface AlertRule {
	id: string;
	name: string;
	enabled: boolean;
	scope: AlertScope;
	condition: AlertCondition;
	cooldownMinutes: number;
	channels: ('telegram' | 'email')[];
	lastFiredAt: string | null;
	userId: string;
	createdAt: string;
	updatedAt: string;
}

export interface AgentCommand {
	id: string;
	agentId: string;
	type: AgentCommandType;
	payload: Record<string, unknown>;
	signature: string;
	status: AgentCommandStatus;
	issuedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timeoutSeconds: number;
	userId: string;
	createdAt: string;
}

export interface AgentMetric {
	id: string;
	agentId: string;
	cpuPercent: number | null;
	memoryUsedBytes: number | null;
	memoryTotalBytes: number | null;
	diskUsedBytes: number | null;
	diskTotalBytes: number | null;
	loadAvg1: number | null;
	loadAvg5: number | null;
	loadAvg15: number | null;
	uptimeSeconds: number | null;
	recordedAt: string;
}

export interface AgentService {
	agentId: string;
	name: string;
	status: string;
	enabled: boolean | null;
	data: Record<string, unknown>;
	updatedAt: string;
}

export interface AgentPackage {
	agentId: string;
	manager: string;
	name: string;
	version: string;
	latestVersion: string;
	updateAvailable: boolean;
	updatedAt: string;
}

export interface RmmSettings {
	defaultCheckinInterval: number;
	staleThresholdMinutes: number;
	metricsRetentionHours: number;
	commandTimeoutSeconds: number;
}

export interface EnrollmentToken {
	id: string;
	name: string;
	expiresAt: string;
	usedAt: string | null;
	createdAt: string;
}
