import { getAgents, getAgent, queryAgentsFiltered } from '$services/agents.js';
import { getCommandHistory, dispatchCommand } from '$services/agent-commands.js';
import { listFindingsByAgent } from '$services/agent-findings.js';
import { getLatestCollectorResult } from '$services/agent-collector-results.js';
import { getAgentSecurityPostureCached } from '$services/security-posture.js';
import { registerTool } from '../tool-registry.js';
import { validateCommandPayload } from '$lib/validators-rmm.js';
import type { Agent, AgentCommandType, FindingCategory, CollectorResultKind } from '$lib/types.js';

// Strip secrets/derived material before any AI tool returns an Agent. The
// model must NEVER see hmacSecret (forge-signed-commands material), tokenHash,
// or any agent.data field (remoteDesktop password, etc.).
type SafeAgent = Omit<Agent, 'hmacSecret'>;
function projectAgent(a: Agent): SafeAgent {
	const { hmacSecret: _hmac, ...rest } = a;
	void _hmac;
	return rest;
}

// MFA-gated actions are refused at the AI surface. Their HTTP-route equivalents
// require a fresh second factor on every call (`/api/agents/[id]/filesystem`
// cleanup is the canonical example); auto-approving them via plan-mode would
// silently downgrade that step-up to a one-shot operator click.
const AI_REFUSED_ACTIONS = new Set<AgentCommandType>(['filesystem_cleanup']);

// Independent of the guardrails tier table: if a future refactor calls the
// handler without going through checkGuardrails (tests, internal dispatch),
// an unrecognised action must still fail closed before reaching the SQL.
const KNOWN_DISPATCH_ACTIONS = new Set<AgentCommandType>([
	'shell', 'script',
	'package_update', 'package_upgrade', 'package_install', 'package_uninstall',
	'software_update', 'os_update', 'check_os_updates',
	'service_action', 'system_info_refresh', 'reboot',
	'filesystem_cleanup',
	'boot_performance_collect',
	'hardware_warranty_collect',
	'cis_audit'
]);

registerTool('list_agents', {
	definition: {
		name: 'list_agents',
		description: 'List all enrolled RMM agents (managed devices) with status, OS, and last-seen time. For filtering by tag, OS, or status, prefer query_agents.',
		input_schema: {
			type: 'object',
			properties: {
				status: { type: 'string', enum: ['online', 'offline', 'pending', 'stale'], description: 'Optional filter by status' }
			}
		}
	},
	handler: async (input) => {
		const status = typeof input.status === 'string' ? input.status : null;
		const agents = getAgents();
		const filtered = status ? agents.filter(a => a.status === status) : agents;
		return filtered.map(a => ({
			id: a.id, name: a.name, hostname: a.hostname, os: a.os, arch: a.arch,
			status: a.status, lastSeenAt: a.lastSeenAt, tags: a.tags
		}));
	}
});

registerTool('get_agent', {
	definition: {
		name: 'get_agent',
		description: 'Get detailed information about a single RMM agent by id, including OS version, agent version, tags, and last-seen.',
		input_schema: {
			type: 'object',
			properties: { id: { type: 'string', description: 'Agent UUID' } },
			required: ['id']
		}
	},
	handler: async (input) => {
		const id = String(input.id);
		const a = getAgent(id);
		if (!a) return { error: `agent ${id} not found` };
		return projectAgent(a);
	}
});

registerTool('get_agent_findings', {
	definition: {
		name: 'get_agent_findings',
		description: 'List recent findings (security/audit observations) for an agent. Categories: peripheral, sensitive_data, network, filesystem, policy.',
		input_schema: {
			type: 'object',
			properties: {
				agentId: { type: 'string' },
				category: { type: 'string', enum: ['peripheral', 'sensitive_data', 'network', 'filesystem', 'policy'] },
				limit: { type: 'number', minimum: 1, maximum: 200, default: 50 }
			},
			required: ['agentId']
		}
	},
	handler: async (input) => {
		const agentId = String(input.agentId);
		const limit = typeof input.limit === 'number' ? input.limit : 50;
		const all = listFindingsByAgent(agentId, limit);
		const cat = typeof input.category === 'string' ? (input.category as FindingCategory) : null;
		return cat ? all.filter(f => f.category === cat) : all;
	}
});

registerTool('get_agent_security_posture', {
	definition: {
		name: 'get_agent_security_posture',
		description: 'Compute a 0..100 security posture score for an agent — composes open findings (sensitive_data, policy/CIS, peripheral, network, filesystem), reliability score, and per-category severity into a single meta-score with risk factors. Cached 5min server-side.',
		input_schema: {
			type: 'object',
			properties: {
				agentId: { type: 'string' }
			},
			required: ['agentId']
		}
	},
	handler: async (input) => {
		const agentId = String(input.agentId);
		return getAgentSecurityPostureCached(agentId);
	}
});

registerTool('get_collector_results', {
	definition: {
		name: 'get_collector_results',
		description: 'Get the latest collector result of a given kind for an agent. Kinds: filesystem_analysis, network_discovery, network_baseline, reliability_daily, peripheral_inventory.',
		input_schema: {
			type: 'object',
			properties: {
				agentId: { type: 'string' },
				kind: { type: 'string', enum: ['filesystem_analysis', 'network_discovery', 'network_baseline', 'reliability_daily', 'peripheral_inventory', 'boot_performance', 'hardware_warranty', 'cis_audit'] }
			},
			required: ['agentId', 'kind']
		}
	},
	handler: async (input) => {
		const agentId = String(input.agentId);
		const kind = String(input.kind) as CollectorResultKind;
		const r = getLatestCollectorResult(agentId, kind);
		if (!r) return { error: `no ${kind} result for agent ${agentId}` };
		return r;
	}
});

registerTool('dispatch_agent_command', {
	definition: {
		name: 'dispatch_agent_command',
		description: 'Dispatch a command to an RMM agent. Risk tier depends on the action: system_info_refresh, check_os_updates, boot_performance_collect, hardware_warranty_collect, and cis_audit are Tier 2; shell, script, reboot, service_action, package_install/uninstall, os_update, software_update, filesystem_cleanup are Tier 3 and require operator approval.',
		input_schema: {
			type: 'object',
			properties: {
				agentId: { type: 'string' },
				action: {
					type: 'string',
					enum: [
						'shell', 'script',
						'package_update', 'package_upgrade', 'package_install', 'package_uninstall',
						'software_update', 'os_update', 'check_os_updates',
						'service_action', 'system_info_refresh', 'reboot',
						'filesystem_cleanup',
						'boot_performance_collect',
						'hardware_warranty_collect',
						'cis_audit'
					]
				},
				payload: { type: 'object', description: 'Payload for the action; shape depends on the action type' },
				timeoutSeconds: { type: 'number', minimum: 5, maximum: 3600 }
			},
			required: ['agentId', 'action']
		}
	},
	handler: async (input, ctx) => {
		const agentId = String(input.agentId);
		const action = String(input.action) as AgentCommandType;
		const payload = (input.payload && typeof input.payload === 'object') ? input.payload as Record<string, unknown> : {};
		const timeoutSeconds = typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : undefined;
		if (!KNOWN_DISPATCH_ACTIONS.has(action)) {
			return { error: `unknown action: ${action}` };
		}
		// Refuse MFA-gated actions from the AI surface — auto-approval would
		// downgrade the per-call MFA step-up the HTTP route enforces.
		if (AI_REFUSED_ACTIONS.has(action)) {
			return { error: `action ${action} cannot be dispatched from the AI surface; the operator must run it from the dashboard so the per-call MFA step-up is enforced` };
		}
		// Run the same per-action payload validation the HTTP route applies.
		const v = validateCommandPayload(action, payload);
		if (!v.ok) return { error: v.message };
		const cmd = dispatchCommand(agentId, action, payload, ctx.userId, timeoutSeconds);
		return { id: cmd.id, status: cmd.status, type: cmd.type, issuedAt: cmd.issuedAt };
	}
});

registerTool('get_agent_command_history', {
	definition: {
		name: 'get_agent_command_history',
		description: 'Recent command history for an agent (most recent first).',
		input_schema: {
			type: 'object',
			properties: {
				agentId: { type: 'string' },
				limit: { type: 'number', minimum: 1, maximum: 100, default: 20 }
			},
			required: ['agentId']
		}
	},
	handler: async (input) => {
		const agentId = String(input.agentId);
		const limit = typeof input.limit === 'number' ? input.limit : 20;
		const cmds = getCommandHistory(agentId, limit);
		return cmds.map(c => ({
			id: c.id, type: c.type, status: c.status,
			issuedAt: c.issuedAt, completedAt: c.completedAt,
			exitCode: c.exitCode, stdout: c.stdout.slice(0, 500), stderr: c.stderr.slice(0, 500)
		}));
	}
});

registerTool('query_agents', {
	definition: {
		name: 'query_agents',
		description: 'Filter agents with the typed filter engine. Conditions is an array of {field, operator, value}. Fields include name, hostname, os, arch, status (online|offline|pending|stale), enabled, lastSeenAt, createdAt, tags (array — use has_any), rebootRequired. Operators depend on field type — date fields support before/after/within_last_minutes/within_last_days; string fields support eq/neq/contains/starts_with/in.',
		input_schema: {
			type: 'object',
			properties: {
				conditions: {
					type: 'array',
					maxItems: 20,
					items: {
						type: 'object',
						properties: {
							field: { type: 'string' },
							operator: { type: 'string' },
							value: {}
						},
						required: ['field', 'operator']
					}
				}
			},
			required: ['conditions']
		}
	},
	handler: async (input) => {
		const conds = Array.isArray(input.conditions) ? input.conditions : [];
		const agents = queryAgentsFiltered(conds as never);
		return agents.map(a => ({
			id: a.id, name: a.name, hostname: a.hostname, os: a.os, arch: a.arch,
			status: a.status, lastSeenAt: a.lastSeenAt, tags: a.tags
		}));
	}
});
