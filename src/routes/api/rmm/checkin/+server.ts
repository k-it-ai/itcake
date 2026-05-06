import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { checkinPayloadSchema } from '$lib/validators-rmm.js';
import { authenticateAgent, signBinaryAdvisory } from '$lib/server/agent-auth.js';
import { signManifest } from '$services/agent-auto-update.js';
import { processCheckin } from '$services/agents.js';
import { ingestMetrics } from '$services/agent-metrics.js';
import { getPendingCommandsRaw, processCommandResult, getCommand } from '$services/agent-commands.js';
import { upsertServices, upsertPackages } from '$services/agent-inventory.js';
import { ingestEvents } from '$services/agent-events.js';
import { processReliabilityResult } from '$services/agent-reliability.js';
import { processPeripheralScanResult, type PeripheralDevice } from '$services/peripheral.js';
import { processSensitiveScanResult } from '$services/sensitive-data.js';
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
			const cmd = getCommand(result.id);
			processCommandResult(result.id, agent.id, {
				status: result.status,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				startedAt: result.startedAt,
				completedAt: result.completedAt
			});
			if (cmd && cmd.agentId === agent.id && result.status === 'completed' && result.stdout) {
				if (cmd.type === 'collect_reliability') {
					try {
						const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
						processReliabilityResult(result.id, agent.id, parsed);
					} catch { /* ignore non-JSON */ }
				}
				if (cmd.type === 'peripheral_scan') {
					try {
						const parsed = JSON.parse(result.stdout) as { devices?: PeripheralDevice[]; policyVersion?: string };
						const devices = Array.isArray(parsed.devices) ? parsed.devices.slice(0, 200) : [];
						processPeripheralScanResult(result.id, agent.id, {
							devices,
							policyVersion: typeof parsed.policyVersion === 'string' ? parsed.policyVersion : undefined
						});
					} catch { /* ignore non-JSON */ }
				}
				if (cmd.type === 'sensitive_data_scan') {
					try {
						const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
						processSensitiveScanResult(result.id, agent.id, parsed);
					} catch { /* ignore non-JSON */ }
				}
			}
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
	const advisoryIssuedAt = new Date().toISOString();
	const binaryAdvisorySig = binaryHash && agent.hmacSecret
		? signBinaryAdvisory(agent.id, binaryHash, advisoryIssuedAt, agent.hmacSecret)
		: '';
	// Optional Ed25519 manifest signature. signManifest returns null
	// when no keypair has been generated; in that case the field is
	// omitted and the agent's no-pubkeys-configured path keeps working.
	const manifestSig = binaryHash ? signManifest(agent.id, binaryHash, advisoryIssuedAt) : null;

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
		...(binaryHash && binaryAdvisorySig ? {
			binaryHash,
			binaryAdvisoryIssuedAt: advisoryIssuedAt,
			binaryAdvisorySignature: binaryAdvisorySig
		} : {}),
		...(manifestSig ? { binaryManifestSignature: manifestSig } : {})
	});
};
