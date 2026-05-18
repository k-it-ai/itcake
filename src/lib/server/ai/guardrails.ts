import type { ApprovalMode } from './types.js';

export type AiTier = 1 | 2 | 3 | 4;

export interface GuardrailResult {
	tier: AiTier;
	allowed: boolean;
	requiresApproval: boolean;
	reason: string;
	description: string;
}

export const TOOL_TIERS = {
	list_agents: 1,
	query_agents: 1,
	get_agent: 1,
	get_agent_findings: 1,
	get_agent_security_posture: 1,
	get_collector_results: 1,
	query_collector_results: 1,
	list_collector_tables: 1,
	get_recovery_readiness: 1,
	list_backup_verifications: 1,
	list_backups: 1,
	get_agent_command_history: 1,
	propose_action_plan: 2,

	verify_backup_integrity: 2,
	run_backup_test_restore: 2,

	dispatch_agent_command: 3
} as const satisfies Readonly<Record<string, AiTier>>;

export type KnownToolName = keyof typeof TOOL_TIERS;

const TIER2_ACTIONS: Record<string, ReadonlySet<string>> = {
	dispatch_agent_command: new Set([
		'system_info_refresh',
		'check_os_updates',
		'boot_performance_collect',
		'hardware_warranty_collect',
		'cis_audit'
	])
};

const TIER3_ACTIONS: Record<string, ReadonlySet<string>> = {
	dispatch_agent_command: new Set([
		'shell',
		'script',
		'reboot',
		'service_action',
		'package_install',
		'package_uninstall',
		'package_update',
		'package_upgrade',
		'os_update',
		'software_update',
		'filesystem_cleanup'
	])
};

export const DISPATCH_AGENT_COMMAND_ACTIONS: ReadonlySet<string> = new Set([
	...TIER2_ACTIONS.dispatch_agent_command,
	...TIER3_ACTIONS.dispatch_agent_command
]);

function isKnownTool(name: string): name is KnownToolName {
	return Object.prototype.hasOwnProperty.call(TOOL_TIERS, name);
}

function actionFromInput(input: unknown): string | null {
	if (!input || typeof input !== 'object') return null;
	const v = (input as Record<string, unknown>).action ?? (input as Record<string, unknown>).type;
	return typeof v === 'string' ? v : null;
}

function descriptionForTool(name: string, action: string | null, input: Record<string, unknown>): string {
	const summary = action ? `${name} (action: ${action})` : name;
	const interesting = ['agentId', 'invoiceId', 'ticketId', 'service', 'command', 'scriptId', 'monitorId']
		.filter(k => k in input)
		.map(k => `${k}=${JSON.stringify(input[k]).slice(0, 80)}`)
		.join(', ');
	return interesting ? `${summary} — ${interesting}` : summary;
}

export function checkGuardrails(
	toolName: string,
	input: unknown,
	mode: ApprovalMode = 'per_step'
): GuardrailResult {
	const safeInput = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
	const action = actionFromInput(input);

	if (!isKnownTool(toolName)) {
		return {
			tier: 4, allowed: false, requiresApproval: false,
			reason: `unknown tool "${toolName}" — fail-closed reject`,
			description: descriptionForTool(toolName, action, safeInput)
		};
	}

	let tier: AiTier = TOOL_TIERS[toolName];

	if (action) {
		if (TIER2_ACTIONS[toolName]?.has(action)) tier = 2;
		else if (TIER3_ACTIONS[toolName]?.has(action)) tier = 3;
		else if (toolName === 'dispatch_agent_command') {
			return {
				tier: 4, allowed: false, requiresApproval: false,
				reason: `unknown command action "${action}" for ${toolName}`,
				description: descriptionForTool(toolName, action, safeInput)
			};
		}
	}

	const description = descriptionForTool(toolName, action, safeInput);

	if (tier === 1) {
		return { tier, allowed: true, requiresApproval: false, reason: 'tier 1 — read-only', description };
	}
	if (tier === 2) {
		const requiresApproval = mode === 'per_step';
		return { tier, allowed: true, requiresApproval, reason: 'tier 2 — low-risk mutation', description };
	}
	return { tier, allowed: true, requiresApproval: true, reason: 'tier 3 — destructive, requires approval', description };
}
