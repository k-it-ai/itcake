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
	// Sticky one-shot marker: set the FIRST time a credit note is issued
	// against this invoice, never reset. The previous "does a credit note
	// row currently exist?" check (stmtCreditNoteExists) let an operator
	// (or a future multi-user `user`-role account) issue → delete →
	// re-issue unlimited credit notes against a single paid invoice,
	// inflating the negative half of the ledger.
	creditNoteIssuedAt?: string | null;
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
	ai?: AiSettings;
	telemetry?: TelemetrySettings;
}

export interface TelemetrySettings {
	errorReportingDsn: string;
	sampleRate?: number;
}

export type ApprovalMode = 'per_step' | 'auto_approve_safe' | 'plan';

export interface AiSettings {
	enabled: boolean;
	apiKey: string;
	model: 'claude-opus-4-7' | 'claude-opus-4-6' | 'claude-sonnet-4-6' | 'claude-haiku-4-5';
	monthlyBudgetCents: number;
	approvalMode: ApprovalMode;
	maxTurnsPerSession: number;
	maxOutputTokensPerTurn: number;
	thinkingMode: 'adaptive' | 'disabled';
	// Consultant mode (default on): the AI is read-only. It can summarise
	// tickets, propose draft responses, and read telemetry from agents, but
	// it CANNOT dispatch commands, mutate state, or otherwise reach client
	// machines. Tier 2+ tools are hidden from the model entirely and any
	// guardrail hit on a non-tier-1 tool fail-closes.
	consultantMode: boolean;
}

export type RemoteDesktopProtocol = 'rdp' | 'vnc' | 'ssh';

export interface AgentRemoteDesktop {
	protocol: RemoteDesktopProtocol;
	host: string;
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
	// Retention for `remote_sessions` rows. The session has 4 lifecycle
	// terminals — unconsumed-expired (token issued, popup never opened),
	// consumed-but-never-started (popup opened, WS handshake never landed),
	// ended (normal full lifecycle), still-running. The prune query covers
	// the first three; `endedRetentionDays` caps the audit window for the
	// "normal full lifecycle" rows, `orphanRetentionDays` caps the
	// consumed-but-never-started row.
	endedRetentionDays: number;
	orphanRetentionDays: number;
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

export type BackupVerificationType = 'integrity' | 'restore';
export type BackupVerificationStatus = 'passed' | 'failed';

export interface BackupVerification {
	id: string;
	filename: string;
	type: BackupVerificationType;
	status: BackupVerificationStatus;
	sizeBytes: number;
	durationMs: number;
	details: { error?: string; integrityCheck?: string; tableCount?: number; documentCount?: number; userCount?: number };
	startedAt: string;
	completedAt: string;
}

export interface RecoveryReadiness {
	score: number;
	riskFactors: string[];
	lastSuccessfulBackupAt: string | null;
	lastIntegrityAt: string | null;
	lastTestRestoreAt: string | null;
	lastOffsiteUploadAt: string | null;
	updatedAt: string;
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
	// Per-admin per-15-minute cap on `/api/changes/integrity` (which
	// iterates every audit row and recomputes HMACs synchronously).
	// Daily cron already persists the result to `audit_integrity_status`;
	// this is the ad-hoc operator override. 0 = disable the gate
	// (relies on the global `/api/*` 600/min IP gate alone).
	auditIntegrityRateLimit: number;
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

// Entity types that custom_field_def + saved_filter rows can apply to.
// Single source so the two surfaces can't drift; both services iterate the
// same set when adding 'monitor' or anything else.
export const EXTENSIBLE_ENTITY_TYPES = ['invoice', 'proposal', 'client', 'ticket', 'expense', 'agent'] as const;
export type ExtensibleEntityType = typeof EXTENSIBLE_ENTITY_TYPES[number];

export type ChangeEntityType = 'invoice' | 'creditNote' | 'proposal' | 'client' | 'expense' | 'settings' | 'catalog_item' | 'unit' | 'template' | 'monitor' | 'ticket' | 'agent' | 'alert_rule' | 'remote_session' | 'custom_field_def' | 'saved_filter' | 'agent_finding' | 'ai_session' | 'ai_tool_execution';
export type ChangeAction = 'create' | 'update' | 'delete' | 'status_change' | 'reopen' | 'send_email' | 'connect' | 'disconnect';

export interface Change {
	id: string;
	entityType: ChangeEntityType;
	entityId: string;
	action: ChangeAction;
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
	| 'service_action' | 'system_info_refresh' | 'reboot'
	| 'peripheral_scan' | 'sensitive_data_scan'
	| 'filesystem_analysis' | 'filesystem_cleanup'
	| 'network_discovery' | 'network_baseline_compare'
	| 'collect_reliability'
	| 'boot_performance_collect'
	| 'hardware_warranty_collect'
	| 'cis_audit';

export type FindingCategory = 'peripheral' | 'sensitive_data' | 'network' | 'filesystem' | 'policy';
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';
export type FindingState = 'open' | 'resolved' | 'accepted' | 'false_positive';

export interface AgentFinding {
	id: string;
	agentId: string;
	category: FindingCategory;
	severity: FindingSeverity;
	title: string;
	evidence: Record<string, unknown>;
	fingerprint: string;
	state: FindingState;
	firstSeenAt: string;
	lastSeenAt: string;
	resolvedAt: string | null;
	userId: string | null;
}

export type CollectorResultKind = 'filesystem_analysis' | 'network_discovery' | 'network_baseline' | 'reliability_daily' | 'peripheral_inventory' | 'boot_performance' | 'hardware_warranty' | 'cis_audit';

export interface AgentCollectorResult {
	id: string;
	agentId: string;
	commandId: string | null;
	kind: CollectorResultKind;
	payload: Record<string, unknown>;
	recordedAt: string;
}

type AgentCommandStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface Agent {
	id: string;
	name: string;
	hostname: string;
	os: string;              // 'darwin' | 'linux' | 'windows'
	arch: string;            // 'amd64' | 'arm64'
	osVersion: string;
	agentVersion: string;
	// The per-agent HMAC secret used to sign commands is intentionally NOT
	// part of this type. It is decrypted only at the dispatch and checkin
	// paths via `getAgentHmacSecret(agentId)` in `agent-auth.ts`. Including
	// it on the Agent shape made it trivial to leak via any operator-facing
	// endpoint that JSON-serialises an Agent.
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

export type AlertActionFailureMode = 'stop' | 'continue';

export type AlertAction =
	| { type: 'notify' }
	| { type: 'shell'; agentId: string; command: string; timeoutSeconds?: number; onFailure?: AlertActionFailureMode }
	| { type: 'script'; agentId: string; command: string; timeoutSeconds?: number; onFailure?: AlertActionFailureMode }
	| { type: 'service_action'; agentId: string; service: string; action: 'start' | 'stop' | 'restart' | 'enable' | 'disable'; onFailure?: AlertActionFailureMode }
	| { type: 'wait'; seconds: number };

export interface AlertRule {
	id: string;
	name: string;
	enabled: boolean;
	scope: AlertScope;
	condition: AlertCondition;
	cooldownMinutes: number;
	channels: ('telegram' | 'email')[];
	actions: AlertAction[];
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
	// Per-agent security-posture aggregate is recomputed every call unless
	// served from this TTL'd in-memory cache. Aggregate is severity-weighted
	// across 6 categories — cheap, but the dashboard hits it for every
	// listed agent on every refresh. Operator can drop to 0 to disable
	// caching entirely (every call recomputes).
	postureCacheTtlSeconds: number;
}

export interface EnrollmentToken {
	id: string;
	name: string;
	expiresAt: string;
	usedAt: string | null;
	createdAt: string;
}
