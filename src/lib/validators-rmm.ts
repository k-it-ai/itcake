import { z } from 'zod';

// --- Enrollment ---

export const createEnrollmentTokenSchema = z.object({
	name: z.string().max(200).default('')
});

export const enrollRequestSchema = z.object({
	token: z.string().min(1).max(200),
	hostname: z.string().max(500).default(''),
	os: z.enum(['darwin', 'linux', 'windows']),
	arch: z.enum(['amd64', 'arm64']),
	osVersion: z.string().max(200).default(''),
	agentVersion: z.string().max(100).default(''),
	/** Agent-generated per-device HMAC secret (hex, 32-128 chars). Required:
	 *  the server signs commands with this key so compromise of one agent
	 *  cannot forge commands for any other. Rejecting missing/weak values at
	 *  the schema boundary means no downgrade path to SESSION_SECRET signing. */
	hmacSecret: z.string().regex(/^[0-9a-f]{32,128}$/i, 'hmacSecret must be 32-128 lowercase hex characters')
});

// --- Agent CRUD ---

/** Tag charset is locked down so values stay safe in URL params and any future
 *  shell-side use (e.g. agent-side filtering). 30 tags max per agent — the
 *  limit is in services/agents.ts::setAgentTags as well. */
export const tagSchema = z.string().min(1).max(50).regex(/^[a-z0-9][a-z0-9_-]{0,49}$/, 'tag must be lowercase alphanumeric with - or _');

export const updateAgentSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	enabled: z.boolean().optional(),
	monitorId: z.string().max(200).nullable().optional()
});

export const setAgentTagsSchema = z.object({
	tags: z.array(tagSchema).max(30)
});

// --- Check-in payload (from Go agent) ---

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
	name: z.string().min(1).max(500),
	status: z.string().max(100).default('unknown'),
	enabled: z.boolean().nullable().default(null),
	data: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).max(200), z.unknown()).default({})
});

const packageInfoSchema = z.object({
	manager: z.string().min(1).max(100),
	name: z.string().min(1).max(500),
	version: z.string().max(200).default(''),
	latestVersion: z.string().max(200).default(''),
	updateAvailable: z.boolean().default(false)
});

const eventInfoSchema = z.object({
	level: z.enum(['critical', 'error', 'warning']),
	source: z.string().max(500).default(''),
	message: z.string().max(2000),
	occurredAt: z.string().max(100)
});

export const checkinPayloadSchema = z.object({
	metrics: metricsPayloadSchema.optional(),
	commandResults: z.array(commandResultSchema).max(100).default([]),
	services: z.array(serviceInfoSchema).max(1000).optional(),
	packages: z.array(packageInfoSchema).max(10000).optional(),
	events: z.array(eventInfoSchema).max(200).optional(),
	hostname: z.string().max(500).optional(),
	osVersion: z.string().max(200).optional(),
	agentVersion: z.string().max(100).optional(),
	packageManagers: z.array(z.string().max(100)).max(20).optional(),
	cpuModel: z.string().max(200).optional(),
	localIp: z.string().max(100).optional()
});

// --- Command dispatch (from UI) ---

const commandTypeEnum = z.enum([
	'shell', 'script',
	'package_update', 'package_upgrade', 'package_install', 'package_uninstall',
	'software_update', 'os_update', 'check_os_updates',
	'service_action', 'system_info_refresh', 'reboot'
]);

const commandPayloadSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).max(200), z.unknown()).default({});

/** Package names: ascii alnum start, then alnum + a small set of separators
 *  common across apt/dnf/pacman/apk/brew/scoop/winget. Bounds it tightly so
 *  metacharacters like `;` `|` `` ` `` `$` `(` `)` `\\` cannot reach the
 *  agent-side shell concatenation in apt.go / brew.go / dnf.go / etc. */
const packageNameRegex = /^[A-Za-z0-9][A-Za-z0-9._+\-@]{0,127}$/;

/** Reboot message: printable text (Unicode letters/numbers + a small set of
 *  punctuation) only. Refuses `$`, backticks, `&`, `|`, `;`, control chars —
 *  the agent's `%q` Go-quoting protects only `"` and `\\` so we belt-and-
 *  brace this on the server. The agent ALSO uses argv form on supported OS,
 *  so this is defense-in-depth. */
const rebootMessageRegex = /^[\p{L}\p{N} .,!?:;()/_\-]{0,200}$/u;

export const dispatchCommandSchema = z.object({
	type: commandTypeEnum,
	payload: commandPayloadSchema,
	timeoutSeconds: z.number().int().min(5).max(3600).default(300)
}).superRefine((data, ctx) => {
	if (data.type === 'shell' || data.type === 'script') {
		if (typeof data.payload.command !== 'string' || !data.payload.command) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Command is required for shell/script type',
				path: ['payload', 'command']
			});
		}
		if (typeof data.payload.command === 'string' && data.payload.command.length > 100_000) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Command too long (max 100KB)',
				path: ['payload', 'command']
			});
		}
	}
	if (data.type === 'package_install' || data.type === 'package_uninstall') {
		if (typeof data.payload.package !== 'string' || !data.payload.package) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Package name is required',
				path: ['payload', 'package']
			});
		} else if (!packageNameRegex.test(data.payload.package)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Package name must start with alphanumeric and contain only [A-Za-z0-9._+@-] (max 128 chars)',
				path: ['payload', 'package']
			});
		}
	}
	if (data.type === 'service_action') {
		if (typeof data.payload.service !== 'string' || !data.payload.service) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Service name is required',
				path: ['payload', 'service']
			});
		} else if (!/^[A-Za-z0-9][A-Za-z0-9._@\-]{0,254}$/.test(data.payload.service)) {
			// Defense-in-depth: keep the service-name charset in lockstep with
			// the Go agent's BuildServiceCommand validator. A name that looks
			// like a flag (`-rf`) or contains shell metas would be command
			// injection when the agent concatenates it into `systemctl <act> <n>`.
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Service name must start with alphanumeric and contain only [A-Za-z0-9._@-] (max 255 chars)',
				path: ['payload', 'service']
			});
		}
		const validActions = ['start', 'stop', 'restart', 'enable', 'disable'];
		if (typeof data.payload.action !== 'string' || !validActions.includes(data.payload.action)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Action must be one of: ${validActions.join(', ')}`,
				path: ['payload', 'action']
			});
		}
	}
	if (data.type === 'reboot') {
		// Optional delaySeconds gives the agent time to ack and finish in-flight work
		// before the OS-level shutdown command actually fires. Bound it so a
		// careless dispatch can't sit in the queue for hours.
		if (data.payload.delaySeconds !== undefined) {
			const ds = data.payload.delaySeconds;
			if (typeof ds !== 'number' || !Number.isFinite(ds) || ds < 0 || ds > 24 * 3600) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'delaySeconds must be a number between 0 and 86400',
					path: ['payload', 'delaySeconds']
				});
			}
		}
		if (data.payload.message !== undefined) {
			if (typeof data.payload.message !== 'string' || data.payload.message.length > 200) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'message must be a string up to 200 chars',
					path: ['payload', 'message']
				});
			} else if (!rebootMessageRegex.test(data.payload.message)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'message contains characters not allowed in shell context',
					path: ['payload', 'message']
				});
			}
		}
	}
});

// --- Bulk dispatch (tag-targeted) ---

/**
 * Re-applies dispatchCommandSchema's per-type payload checks at the bulk
 * level. Sharing the function keeps single-agent and bulk validation in
 * lockstep — anything rejected for one agent must be rejected for many.
 */
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
	if (data.type === 'package_install' || data.type === 'package_uninstall') {
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

export const bulkDispatchSchema = z.object({
	tagAny: z.array(tagSchema).max(30).default([]),
	tagAll: z.array(tagSchema).max(30).default([]),
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

// --- Schedules ---

const scheduleTypeEnum = z.enum([
	'shell', 'script',
	'package_update', 'package_upgrade', 'package_install',
	'software_update', 'os_update', 'check_os_updates',
	'service_action', 'system_info_refresh', 'reboot'
]);

export const createScheduleSchema = z.object({
	name: z.string().min(1).max(200),
	type: scheduleTypeEnum,
	payload: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).max(200), z.unknown()).default({}),
	cronExpression: z.string().min(1).max(100),
	timeoutSeconds: z.number().int().min(5).max(3600).default(300),
	enabled: z.boolean().default(true)
});

export const updateScheduleSchema = createScheduleSchema.partial();

// --- Alerting rules ---

const metricThresholdCondition = z.object({
	kind: z.literal('metric_threshold'),
	metric: z.enum(['cpu', 'memory', 'disk']),
	op: z.enum(['>', '>=', '<', '<=']),
	value: z.number().finite().min(0).max(100),
	durationMinutes: z.number().int().min(0).max(720).default(0),
	tagAny: z.array(tagSchema).max(30).default([])
});

const agentOfflineCondition = z.object({
	kind: z.literal('agent_offline'),
	durationMinutes: z.number().int().min(1).max(720),
	tagAny: z.array(tagSchema).max(30).default([])
});

const agentRebootRequiredCondition = z.object({
	kind: z.literal('agent_reboot_required'),
	tagAny: z.array(tagSchema).max(30).default([])
});

const monitorStatusCondition = z.object({
	kind: z.literal('monitor_status'),
	status: z.enum(['down', 'error']),
	monitorIds: z.array(z.string().max(200)).max(100).default([])
});

const alertConditionSchema = z.discriminatedUnion('kind', [
	metricThresholdCondition,
	agentOfflineCondition,
	agentRebootRequiredCondition,
	monitorStatusCondition
]);

const alertScopeFor = (kind: string): 'agent_metric' | 'agent_offline' | 'agent_reboot_required' | 'monitor_status' => {
	switch (kind) {
		case 'metric_threshold': return 'agent_metric';
		case 'agent_offline': return 'agent_offline';
		case 'agent_reboot_required': return 'agent_reboot_required';
		case 'monitor_status': return 'monitor_status';
		default: throw new Error('unknown condition kind: ' + kind);
	}
};

export { alertScopeFor };

export const createAlertRuleSchema = z.object({
	name: z.string().min(1).max(200),
	enabled: z.boolean().default(true),
	condition: alertConditionSchema,
	cooldownMinutes: z.number().int().min(1).max(10080).default(60),
	channels: z.array(z.enum(['telegram', 'email'])).min(1).max(2).default(['telegram', 'email'])
});

export const updateAlertRuleSchema = createAlertRuleSchema.partial();

// --- Remote desktop ---

/**
 * Per-agent Guacamole connection profile. Hostname is taken from agents.ip
 * — operators don't control it; spoofing requires write access to the agent
 * itself which is a separate compromise. Username/password live encrypted
 * at rest via field-crypto.
 */
export const agentRemoteDesktopSchema = z.object({
	protocol: z.enum(['rdp', 'vnc', 'ssh']),
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

// --- RMM settings ---

export const rmmSettingsSchema = z.object({
	defaultCheckinInterval: z.number().int().min(10).max(3600).default(60),
	staleThresholdMinutes: z.number().int().min(1).max(60).default(5),
	metricsRetentionHours: z.number().int().min(1).max(720).default(48),
	commandTimeoutSeconds: z.number().int().min(5).max(3600).default(300)
});
