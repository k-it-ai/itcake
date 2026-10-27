import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleAdminActionPost, notFound, requireUser } from '#lib/server/request-utils.js';
import { getAgent } from '#services/agents.js';
import { dispatchCommand } from '#services/agent-commands.js';
import {
	validateNetworkScanOptions,
	setNetworkBaseline,
	getNetworkSnapshot
} from '#services/network-baseline.js';
import { LegacyEnrollmentError } from '#lib/server/agent-auth.js';
import { emitAgentEvent } from '#lib/server/agent-events.js';
import { ServiceError } from '#lib/server/service-error.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const agent = getAgent(params.id);
	if (!agent) throw notFound();
	return json(getNetworkSnapshot(params.id));
};

export const POST: RequestHandler = ({ params, request, locals }) =>
	handleAdminActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			discover: async (data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				if (!agent.enabled) throw error(400, 'Agent is disabled');
				if (agent.status === 'offline') throw error(400, 'Agent is offline');
				let opts;
				try {
					opts = validateNetworkScanOptions(data.opts);
				} catch (e) {
					throw error(400, e instanceof Error ? e.message : 'Invalid opts');
				}
				try {
					const cmd = dispatchCommand(params.id, 'network_discovery', { opts }, userId, opts.timeoutSeconds + 30);
					emitAgentEvent();
					return json(cmd, { status: 201 });
				} catch (e) {
					if (e instanceof LegacyEnrollmentError) throw error(409, e.message);
					throw e;
				}
			},
			'compare-baseline': async (data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				if (!agent.enabled) throw error(400, 'Agent is disabled');
				if (agent.status === 'offline') throw error(400, 'Agent is offline');
				let opts;
				try {
					opts = validateNetworkScanOptions(data.opts);
				} catch (e) {
					throw error(400, e instanceof Error ? e.message : 'Invalid opts');
				}
				try {
					const cmd = dispatchCommand(params.id, 'network_baseline_compare', { opts }, userId, opts.timeoutSeconds + 30);
					emitAgentEvent();
					return json(cmd, { status: 201 });
				} catch (e) {
					if (e instanceof LegacyEnrollmentError) throw error(409, e.message);
					throw e;
				}
			},
			'set-baseline': async (_data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				try {
					const out = setNetworkBaseline(params.id, userId);
					return json(out);
				} catch (e) {
					if (e instanceof ServiceError) throw error(404, 'Agent not found');
					throw error(400, e instanceof Error ? e.message : 'Failed to set baseline');
				}
			}
		}
	});
