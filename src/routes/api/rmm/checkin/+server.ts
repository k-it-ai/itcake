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
import { getSetting } from '$lib/server/db.js';
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

	// Update agent info
	processCheckin(agent.id, {
		hostname: data.hostname,
		osVersion: data.osVersion,
		agentVersion: data.agentVersion,
		packageManagers: data.packageManagers,
		cpuModel: data.cpuModel,
		ip: data.localIp || ip,
		rebootRequired: data.metrics?.rebootRequired ?? null
	});

	// Ingest metrics
	if (data.metrics) {
		ingestMetrics(agent.id, data.metrics);
	}

	// Process command results — agent.id ensures an agent can only update its own commands
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

	// Update service inventory
	if (data.services) {
		upsertServices(agent.id, data.services);
	}

	// Update package inventory
	if (data.packages) {
		upsertPackages(agent.id, data.packages);
	}

	// Ingest system-log events (capped + pruned by retention setting)
	if (data.events) {
		ingestEvents(agent.id, data.events);
	}

	// Emit SSE event for UI updates
	emitAgentEvent();

	// Return pending commands + config
	const pending = getPendingCommandsRaw(agent.id);
	const settings = getSetting<RmmSettings>('rmm');

	// Include binary hash so the agent can detect when a newer version is available
	const binaryHash = getAgentBinaryHash(agent.os, agent.arch);

	// Security notes:
	//   - `issuedAt` is part of the signed HMAC message; the agent MUST
	//     receive it verbatim or verification fails. This was missing from
	//     older protocol versions — agents effectively skipped verification.
	//   - `payload` is a JSON-PARSED object sent as-is, AND `payloadRaw` is
	//     the exact byte string that was HMAC'd at dispatch. New agents
	//     verify the HMAC over `payloadRaw`, not over `JSON.stringify(payload)`
	//     — re-serialization is not byte-stable (key order, escaping) and
	//     would produce spurious signature mismatches.
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
