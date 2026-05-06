import { getAgents, getAgent, queryAgentsFiltered } from '$services/agents.js';
import { getCommandHistory, dispatchCommand } from '$services/agent-commands.js';
import { listFindingsByAgent } from '$services/agent-findings.js';
import { getLatestCollectorResult } from '$services/agent-collector-results.js';
import { registerTool } from '../tool-registry.js';
import type { AgentCommandType, FindingCategory, CollectorResultKind } from '$lib/types.js';

registerTool('list_agents', {
	definition: {
		name: 'list_agents',
		description: 'List all enrolled RMM agents (managed devices) with status, OS, and last-seen time. For filtering by tag, OS, or status, prefer query_documents with appliesTo=agent.',
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
		return a;
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

registerTool('get_collector_results', {
	definition: {
		name: 'get_collector_results',
		description: 'Get the latest collector result of a given kind for an agent. Kinds: filesystem_analysis, network_discovery, network_baseline, reliability_daily, peripheral_inventory.',
		input_schema: {
			type: 'object',
			properties: {
				agentId: { type: 'string' },
				kind: { type: 'string', enum: ['filesystem_analysis', 'network_discovery', 'network_baseline', 'reliability_daily', 'peripheral_inventory'] }
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
		description: 'Dispatch a command to an RMM agent. Risk tier depends on the action: system_info_refresh and check_os_updates are Tier 2; shell, script, reboot, service_action, package_install/uninstall, os_update, software_update, filesystem_cleanup are Tier 3 and require operator approval.',
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
						'filesystem_cleanup'
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

void queryAgentsFiltered;
