import { z } from 'zod';
import net from 'node:net';

const safeText = (max: number) =>
	z.string().max(max).regex(/^[^\r\n\0]*$/, 'must not contain newline or null bytes');


export const createEnrollmentTokenSchema = z.object({
	name: safeText(200).default('')
});

export const enrollRequestSchema = z.object({
	token: z.string().min(1).max(200),
	hostname: safeText(500).default(''),
	os: z.enum(['darwin', 'linux', 'windows']),
	arch: z.enum(['amd64', 'arm64']),
	osVersion: safeText(200).default(''),
	agentVersion: safeText(100).default(''),
	hmacSecret: z.string().regex(/^[0-9a-f]{64,128}$/i, 'hmacSecret must be 64-128 hex characters')
});


export const TAG_REGEX = /^[a-z0-9][a-z0-9_-]{0,49}$/;
export const MAX_TAGS_PER_AGENT = 30;
const tagSchema = z.string().min(1).max(50).regex(TAG_REGEX, 'tag must be lowercase alphanumeric with - or _');

export const updateAgentSchema = z.object({
	name: safeText(200).min(1).optional(),
	enabled: z.boolean().optional(),
	monitorId: z.string().max(200).nullable().optional()
});

export const setAgentTagsSchema = z.object({
	tags: z.array(tagSchema).max(MAX_TAGS_PER_AGENT)
});


const metricsPayloadSchema = z.object({
	cpuPercent: z.number().finite().min(0).max(100).nullable().default(null),
	memoryUsedBytes: z.number().int().finite().min(0).nullable().default(null),
	memoryTotalBytes: z.number().int().finite().min(0).nullable().default(null),
	diskUsedBytes: z.number().int().finite().min(0).nullable().default(null),
	diskTotalBytes: z.number().int().finite().min(0).nullable().default(null),
	loadAvg1: z.number().finite().min(0).nullable().default(null),
	loadAvg5: z.number().finite().min(0).nullable().default(null),
	loadAvg15: z.number().finite().min(0).nullable().default(null),
	uptimeSeconds: z.number().int().finite().min(0).nullable().default(null),
	rebootRequired: z.boolean().nullable().optional()
});

const commandResultSchema = z.object({
	id: z.string().min(1).max(200),
	status: z.enum(['running', 'completed', 'failed']),
	exitCode: z.number().int().nullable().default(null),
	stdout: z.string().max(1_048_576).default(''),  // 1MB cap
	stderr: z.string().max(262_144).default(''),     // 256KB cap
	startedAt: z.string().max(100).nullable().default(null),
	completedAt: z.string().max(100).nullable().default(null)
});

const serviceInfoSchema = z.object({
	name: safeText(500).min(1),
	status: safeText(100).default('unknown'),
	enabled: z.boolean().nullable().default(null),
	data: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).max(200), z.unknown()).default({})
});

const packageInfoSchema = z.object({
	manager: safeText(100).min(1),
	name: safeText(500).min(1),
	version: safeText(200).default(''),
	latestVersion: safeText(200).default(''),
	updateAvailable: z.boolean().default(false)
});

const eventInfoSchema = z.object({
	level: z.enum(['critical', 'error', 'warning']),
	source: safeText(500).default(''),
	message: z.string().max(2000).refine(v => !/[\x00-\x08\x0B-\x1F\x7F]/.test(v), 'message contains control characters'),
	occurredAt: z.string().max(100)
});

export const checkinPayloadSchema = z.object({
	metrics: metricsPayloadSchema.optional(),
	commandResults: z.array(commandResultSchema).max(100).default([]),
	services: z.array(serviceInfoSchema).max(1000).optional(),
	packages: z.array(packageInfoSchema).max(10000).optional(),
	events: z.array(eventInfoSchema).max(200).optional(),
	hostname: safeText(500).optional(),
	osVersion: safeText(200).optional(),
	agentVersion: safeText(100).optional(),
	packageManagers: z.array(safeText(100)).max(20).optional(),
	cpuModel: safeText(200).optional(),
	localIp: z.string().max(100).refine(v => !v || net.isIP(v) > 0, 'localIp must be a valid IPv4 or IPv6 address').optional()
});


const commandTypeEnum = z.enum([
	'shell', 'script',
	'package_update', 'package_upgrade', 'package_install', 'package_uninstall',
	'software_update', 'os_update', 'check_os_updates',
	'service_action', 'system_info_refresh', 'reboot',
	'peripheral_scan', 'sensitive_data_scan',
	'filesystem_analysis', 'filesystem_cleanup',
	'network_discovery', 'network_baseline_compare',
	'collect_reliability'
]);

const commandPayloadSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).max(200), z.unknown()).default({});

const packageNameRegex = /^[A-Za-z0-9][A-Za-z0-9._+\-@]{0,127}$/;

const rebootMessageRegex = /^[\p{L}\p{N} .,!?:;()/_\-]{0,200}$/u;

const SCHEDULE_PAYLOAD_MAX_BYTES = 100_000;

/**
 * Per-command-type payload validation. Shared by single-agent dispatch and
 * tag-targeted bulk dispatch — anything rejected for one path must be
 * rejected for the other, so they go through the same function.
 */
export function validateCommandPayload(
	type: string,
	payload: Record<string, unknown>
): { ok: true } | { ok: false; message: string } {
	let issue: string | null = null;
	const ctx: z.RefinementCtx = {
		addIssue: (i) => {
			if (issue) return;
			const path = i.path && i.path.length ? `${i.path.join('.')}: ` : '';
			issue = `${path}${i.message ?? 'invalid payload'}`;
		},
		path: []
	} as unknown as z.RefinementCtx;
	refinePayloadByType({ type, payload }, ctx);
	if (issue) return { ok: false, message: issue };
	if (JSON.stringify(payload).length > SCHEDULE_PAYLOAD_MAX_BYTES) {
		return { ok: false, message: `payload exceeds ${SCHEDULE_PAYLOAD_MAX_BYTES} bytes` };
	}
	return { ok: true };
}

function refinePayloadByType(
	data: { type: string; payload: Record<string, unknown> },
	ctx: z.RefinementCtx
): void {
	if (data.type === 'shell' || data.type === 'script') {
		if (typeof data.payload.command !== 'string' || !data.payload.command) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Command is required for shell/script type', path: ['payload', 'command'] });
		}
		if (typeof data.payload.command === 'string' && data.payload.command.length > 100_000) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Command too long (max 100KB)', path: ['payload', 'command'] });
		}
	}
	if (data.type === 'package_install' || data.type === 'package_uninstall' || data.type === 'package_update') {
		if (typeof data.payload.package !== 'string' || !data.payload.package) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Package name is required', path: ['payload', 'package'] });
		} else if (!packageNameRegex.test(data.payload.package)) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Package name must start with alphanumeric and contain only [A-Za-z0-9._+@-] (max 128 chars)', path: ['payload', 'package'] });
		}
	}
	if (data.type === 'service_action') {
		if (typeof data.payload.service !== 'string' || !data.payload.service) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Service name is required', path: ['payload', 'service'] });
		} else if (!/^[A-Za-z0-9][A-Za-z0-9._@\-]{0,254}$/.test(data.payload.service)) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Service name must start with alphanumeric and contain only [A-Za-z0-9._@-] (max 255 chars)', path: ['payload', 'service'] });
		}
		const validActions = ['start', 'stop', 'restart', 'enable', 'disable'];
		if (typeof data.payload.action !== 'string' || !validActions.includes(data.payload.action)) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Action must be one of: ${validActions.join(', ')}`, path: ['payload', 'action'] });
		}
	}
	if (data.type === 'peripheral_scan') {
		// Empty payload OK — agent enumerates everything. policyVersion is
		// an optional string the operator can use to confirm the agent's
		// view matched the policy version they expected.
		if (data.payload.policyVersion !== undefined && typeof data.payload.policyVersion !== 'string') {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'policyVersion must be a string', path: ['payload', 'policyVersion'] });
		}
	}
	if (data.type === 'reboot') {
		if (data.payload.delaySeconds !== undefined) {
			const ds = data.payload.delaySeconds;
			if (typeof ds !== 'number' || !Number.isFinite(ds) || ds < 0 || ds > 24 * 3600) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'delaySeconds must be a number between 0 and 86400', path: ['payload', 'delaySeconds'] });
			}
		}
		if (data.payload.message !== undefined) {
			if (typeof data.payload.message !== 'string' || data.payload.message.length > 200) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'message must be a string up to 200 chars', path: ['payload', 'message'] });
			} else if (!rebootMessageRegex.test(data.payload.message)) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'message contains characters not allowed in shell context', path: ['payload', 'message'] });
			}
		}
	}
}

export const dispatchCommandSchema = z.object({
	type: commandTypeEnum,
	payload: commandPayloadSchema,
	timeoutSeconds: z.number().int().min(5).max(3600).default(300)
}).superRefine(refinePayloadByType);


export const bulkDispatchSchema = z.object({
	tagAny: z.array(tagSchema).max(MAX_TAGS_PER_AGENT).default([]),
	tagAll: z.array(tagSchema).max(MAX_TAGS_PER_AGENT).default([]),
	type: commandTypeEnum,
	payload: commandPayloadSchema,
	timeoutSeconds: z.number().int().min(5).max(3600).default(300)
}).superRefine((data, ctx) => {
	if (data.tagAny.length === 0 && data.tagAll.length === 0) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'tagAny or tagAll required for bulk dispatch',
			path: ['tagAny']
		});
	}
	refinePayloadByType(data, ctx);
});


const scheduleTypeEnum = z.enum([
	'shell', 'script',
	'package_update', 'package_upgrade', 'package_install',
	'software_update', 'os_update', 'check_os_updates',
	'service_action', 'system_info_refresh', 'reboot',
	'peripheral_scan', 'sensitive_data_scan',
	'filesystem_analysis',
	'network_discovery', 'network_baseline_compare',
	'collect_reliability'
]);

function refineSchedulePayloadSize(
	data: { payload?: Record<string, unknown> },
	ctx: z.RefinementCtx
): void {
	if (!data.payload) return;
	if (JSON.stringify(data.payload).length > SCHEDULE_PAYLOAD_MAX_BYTES) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `payload exceeds ${SCHEDULE_PAYLOAD_MAX_BYTES} bytes`,
			path: ['payload']
		});
	}
}

export const createScheduleSchema = z.object({
	name: z.string().min(1).max(200),
	type: scheduleTypeEnum,
	payload: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).max(200), z.unknown()).default({}),
	cronExpression: z.string().min(1).max(100),
	timeoutSeconds: z.number().int().min(5).max(3600).default(300),
	enabled: z.boolean().default(true)
}).superRefine((data, ctx) => {
	refinePayloadByType({ type: data.type, payload: data.payload }, ctx);
	refineSchedulePayloadSize(data, ctx);
});

export const updateScheduleSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	type: scheduleTypeEnum.optional(),
	payload: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).max(200), z.unknown()).optional(),
	cronExpression: z.string().min(1).max(100).optional(),
	timeoutSeconds: z.number().int().min(5).max(3600).optional(),
	enabled: z.boolean().optional()
}).superRefine((data, ctx) => {
	if (data.payload && !data.type) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'type is required when payload is updated',
			path: ['type']
		});
		return;
	}
	if (data.type && data.payload) {
		refinePayloadByType({ type: data.type, payload: data.payload }, ctx);
	}
	if (data.payload) {
		refineSchedulePayloadSize({ payload: data.payload }, ctx);
	}
});


const metricThresholdCondition = z.object({
	kind: z.literal('metric_threshold'),
	metric: z.enum(['cpu', 'memory', 'disk']),
	op: z.enum(['>', '>=', '<', '<=']),
	value: z.number().finite().min(0).max(100),
	durationMinutes: z.number().int().min(0).max(720).default(0),
	tagAny: z.array(tagSchema).max(MAX_TAGS_PER_AGENT).default([])
}).strict();

const agentOfflineCondition = z.object({
	kind: z.literal('agent_offline'),
	durationMinutes: z.number().int().min(1).max(720),
	tagAny: z.array(tagSchema).max(MAX_TAGS_PER_AGENT).default([])
}).strict();

const agentRebootRequiredCondition = z.object({
	kind: z.literal('agent_reboot_required'),
	tagAny: z.array(tagSchema).max(MAX_TAGS_PER_AGENT).default([])
}).strict();

const monitorStatusCondition = z.object({
	kind: z.literal('monitor_status'),
	status: z.enum(['down', 'error']),
	monitorIds: z.array(z.string().max(200)).max(100).default([])
}).strict();

const alertConditionSchema = z.discriminatedUnion('kind', [
	metricThresholdCondition,
	agentOfflineCondition,
	agentRebootRequiredCondition,
	monitorStatusCondition
]);

export const alertScopeFor = (kind: string): 'agent_metric' | 'agent_offline' | 'agent_reboot_required' | 'monitor_status' => {
	switch (kind) {
		case 'metric_threshold': return 'agent_metric';
		case 'agent_offline': return 'agent_offline';
		case 'agent_reboot_required': return 'agent_reboot_required';
		case 'monitor_status': return 'monitor_status';
		default: throw new Error('unknown condition kind: ' + kind);
	}
};

const onFailureSchema = z.enum(['stop', 'continue']).optional();

const alertActionSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('notify') }).strict(),
	z.object({
		type: z.literal('shell'),
		agentId: z.string().min(1).max(200),
		command: z.string().min(1).max(100_000),
		timeoutSeconds: z.number().int().min(5).max(3600).optional(),
		onFailure: onFailureSchema
	}).strict(),
	z.object({
		type: z.literal('script'),
		agentId: z.string().min(1).max(200),
		command: z.string().min(1).max(100_000),
		timeoutSeconds: z.number().int().min(5).max(3600).optional(),
		onFailure: onFailureSchema
	}).strict(),
	z.object({
		type: z.literal('service_action'),
		agentId: z.string().min(1).max(200),
		service: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._@\-]{0,254}$/),
		action: z.enum(['start', 'stop', 'restart', 'enable', 'disable']),
		onFailure: onFailureSchema
	}).strict(),
	z.object({
		type: z.literal('wait'),
		seconds: z.number().int().min(1).max(3600)
	}).strict()
]);

const alertActionsSchema = z.array(alertActionSchema).max(20).default([]);

export const createAlertRuleSchema = z.object({
	name: z.string().min(1).max(200),
	enabled: z.boolean().default(true),
	condition: alertConditionSchema,
	cooldownMinutes: z.number().int().min(1).max(10080).default(60),
	channels: z.array(z.enum(['telegram', 'email'])).min(1).max(2).default(['telegram', 'email']),
	actions: alertActionsSchema
});

export const updateAlertRuleSchema = createAlertRuleSchema.partial();


export const agentRemoteDesktopSchema = z.object({
	protocol: z.enum(['rdp', 'vnc', 'ssh']),
	host: z.string().min(1).max(255).refine((s) => s.trim().length > 0, 'host must not be empty or whitespace'),
	port: z.number().int().min(1).max(65535),
	username: z.string().max(200).default(''),
	password: z.string().max(2000).default(''),
	domain: z.string().max(200).optional(),
	ignoreCert: z.boolean().optional(),
	privateKey: z.string().max(20000).optional(),
	recording: z.boolean().optional()
});

export const remoteDesktopSettingsSchema = z.object({
	enabled: z.boolean().default(false),
	guacdHost: z.string().max(255).default('127.0.0.1'),
	guacdPort: z.number().int().min(1).max(65535).default(4822),
	proxyPort: z.number().int().min(1024).max(65535).default(4823),
	recordingEnabled: z.boolean().default(false),
	maxSessionMinutes: z.number().int().min(1).max(1440).default(60),
	tokenTtlSeconds: z.number().int().min(30).max(3600).default(300)
});


export const rmmSettingsSchema = z.object({
	defaultCheckinInterval: z.number().int().min(10).max(3600).default(60),
	staleThresholdMinutes: z.number().int().min(1).max(60).default(5),
	metricsRetentionHours: z.number().int().min(1).max(720).default(48),
	commandTimeoutSeconds: z.number().int().min(5).max(3600).default(300)
});


const peripheralExceptionSchema = z.object({
	vendor: z.string().max(200).optional(),
	product: z.string().max(200).optional(),
	serialNumber: z.string().max(200).optional(),
	allow: z.boolean(),
	expiresAt: z.string().max(50).optional()
}).refine(
	v => !!(v.vendor || v.product || v.serialNumber),
	{ message: 'exception must specify at least one of vendor, product, serialNumber' }
);

export const peripheralPolicySchema = z.object({
	deviceClass: z.enum(['storage', 'all_usb', 'bluetooth', 'thunderbolt']),
	action: z.enum(['allow', 'block', 'read_only', 'alert']),
	exceptions: z.array(peripheralExceptionSchema).max(200).default([])
});
