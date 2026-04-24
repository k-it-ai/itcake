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
	/** Agent-generated per-device HMAC secret (hex, 32-128 chars). Required
	 *  for new enrollments so the server can sign commands with a key only
	 *  this agent knows. Optional on schema for compatibility with legacy
	 *  agents — but server rejects empty string at service layer. */
	hmacSecret: z.string().regex(/^[0-9a-f]{32,128}$/i, 'hmacSecret must be 32-128 hex chars').optional()
});

// --- Agent CRUD ---

export const updateAgentSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	enabled: z.boolean().optional(),
	monitorId: z.string().max(200).nullable().optional()
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

export const checkinPayloadSchema = z.object({
	metrics: metricsPayloadSchema.optional(),
	commandResults: z.array(commandResultSchema).max(100).default([]),
	services: z.array(serviceInfoSchema).max(1000).optional(),
	packages: z.array(packageInfoSchema).max(10000).optional(),
	hostname: z.string().max(500).optional(),
	osVersion: z.string().max(200).optional(),
	agentVersion: z.string().max(100).optional(),
	packageManagers: z.array(z.string().max(100)).max(20).optional(),
	cpuModel: z.string().max(200).optional(),
	localIp: z.string().max(100).optional()
});

// --- Command dispatch (from UI) ---

export const dispatchCommandSchema = z.object({
	type: z.enum([
		'shell', 'script',
		'package_update', 'package_upgrade', 'package_install', 'package_uninstall',
		'software_update', 'os_update', 'check_os_updates',
		'service_action', 'system_info_refresh'
	]),
	payload: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).max(200), z.unknown()).default({}),
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
		}
	}
	if (data.type === 'service_action') {
		if (typeof data.payload.service !== 'string' || !data.payload.service) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Service name is required',
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
});

// --- RMM settings ---

export const rmmSettingsSchema = z.object({
	defaultCheckinInterval: z.number().int().min(10).max(3600).default(60),
	staleThresholdMinutes: z.number().int().min(1).max(60).default(5),
	metricsRetentionHours: z.number().int().min(1).max(720).default(48),
	commandTimeoutSeconds: z.number().int().min(5).max(3600).default(300)
});
