import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { checkinPayloadSchema } from '$lib/validators-rmm.js';
import { authenticateAgent } from '$lib/server/agent-auth.js';
import { processCheckin } from '$services/agents.js';
import { ingestMetrics } from '$services/agent-metrics.js';
import { getPendingCommandsRaw, processCommandResult } from '$services/agent-commands.js';
import { upsertServices, upsertPackages } from '$services/agent-inventory.js';
import { ingestEvents } from '$services/agent-events.js';
import { emitAgentEvent } from '$lib/server/agent-events.js';
import { db, getSetting } from '$lib/server/db.js';
import { getAgentBinaryHash } from '$lib/server/agent-build.js';
import type { RmmSettings } from '$lib/types.js';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const agent = authenticateAgent(request);
	if (!agent) return json({ error: 'Invalid or missing bearer token' }, { status: 401 });

	let body: unknown;
	try {
		body = await parseJsonBody(request);
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = checkinPayloadSchema.safeParse(body);
	if (!parsed.success) {
		return json({ error: parsed.error.issues.map(i => i.message).join(', ') }, { status: 400 });
	}

	const data = parsed.data;
	const ip = getClientAddress();

	db.transaction(() => {
		processCheckin(agent.id, {
			hostname: data.hostname,
			osVersion: data.osVersion,
			agentVersion: data.agentVersion,
			packageManagers: data.packageManagers,
			cpuModel: data.cpuModel,
			ip: data.localIp || ip,
			rebootRequired: data.metrics?.rebootRequired ?? null
		});

		if (data.metrics) {
			ingestMetrics(agent.id, data.metrics);
		}

		for (const result of data.commandResults) {
			processCommandResult(result.id, agent.id, {
				status: result.status,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				startedAt: result.startedAt,
				completedAt: result.completedAt
			});
		}

		if (data.services) {
			upsertServices(agent.id, data.services);
		}

		if (data.packages) {
			upsertPackages(agent.id, data.packages);
		}

		if (data.events) {
			ingestEvents(agent.id, data.events);
		}
	})();

	emitAgentEvent();

	const pending = getPendingCommandsRaw(agent.id);
	const settings = getSetting<RmmSettings>('rmm');

	const binaryHash = getAgentBinaryHash(agent.os, agent.arch);

	// Security notes:
	//   - `issuedAt` is part of the signed HMAC message; the agent MUST
	return json({
		commands: pending.map(cmd => ({
			id: cmd.id,
			agentId: cmd.agentId,
			type: cmd.type,
			payload: cmd.payload,
			payloadRaw: cmd.payloadRaw,
			signature: cmd.signature,
			issuedAt: cmd.issuedAt,
			timeoutSeconds: cmd.timeoutSeconds
		})),
		checkinInterval: settings?.defaultCheckinInterval ?? 60,
		...(binaryHash ? { binaryHash } : {})
	});
};
