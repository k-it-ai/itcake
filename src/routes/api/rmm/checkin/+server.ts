import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { checkinPayloadSchema } from '$lib/validators-rmm.js';
import { authenticateAgent, signBinaryAdvisory, getAgentHmacSecret } from '$lib/server/agent-auth.js';
import { signManifest, getManifestRotationHistory } from '$services/agent-auto-update.js';
import { processCheckin } from '$services/agents.js';
import { ingestMetrics } from '$services/agent-metrics.js';
import { getPendingCommandsRaw, processCommandResult, getCommand } from '$services/agent-commands.js';
import { upsertServices, upsertPackages } from '$services/agent-inventory.js';
import { ingestEvents } from '$services/agent-events.js';
import { processReliabilityResult } from '$services/agent-reliability.js';
import { processBootPerformanceResult } from '$services/boot-performance.js';
import { processHardwareWarrantyResult } from '$services/hardware-warranty.js';
import { processCisAuditResult } from '$services/cis-audit.js';
import { processPeripheralScanResult, type PeripheralDevice } from '$services/peripheral.js';
import { processSensitiveScanResult } from '$services/sensitive-data.js';
import { processFilesystemAnalysisResult, processFilesystemCleanupResult } from '$services/filesystem.js';
import { processNetworkDiscoveryResult, processNetworkBaselineCompare } from '$services/network-baseline.js';
import { emitAgentEvent } from '$lib/server/agent-events.js';
import { db, getSetting } from '$lib/server/db.js';
import { getAgentBinaryHash } from '$lib/server/agent-build.js';
import type { RmmSettings } from '$lib/types.js';
import { checkAndRecordAttempt } from '$lib/server/rate-limit.js';

const CHECKIN_RATE_LIMIT_PER_15MIN = 60;

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const agent = authenticateAgent(request);
	if (!agent) return json({ error: 'Invalid or missing bearer token' }, { status: 401 });

	try {
		checkAndRecordAttempt(`checkin:${agent.id}`, CHECKIN_RATE_LIMIT_PER_15MIN, 'Checkin rate exceeded');
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'rate limited';
		return json({ error: msg }, { status: 429 });
	}

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
			// Read status BEFORE processCommandResult so a re-submit while
			// status='running' can't write a second collector row.
			const wasPending = cmd?.status === 'pending';
			processCommandResult(result.id, agent.id, {
				status: result.status,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				startedAt: result.startedAt,
				completedAt: result.completedAt,
				transient: result.transient ?? false
			});
			if (cmd && cmd.agentId === agent.id && wasPending && result.status === 'completed' && result.stdout) {
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
				if (cmd.type === 'filesystem_analysis') {
					try {
						const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
						processFilesystemAnalysisResult(result.id, agent.id, parsed);
					} catch { /* ignore non-JSON */ }
				}
				if (cmd.type === 'filesystem_cleanup') {
					try {
						const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
						processFilesystemCleanupResult(result.id, agent.id, parsed);
					} catch { /* ignore non-JSON */ }
				}
				if (cmd.type === 'network_discovery') {
					try {
						const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
						processNetworkDiscoveryResult(result.id, agent.id, parsed);
					} catch { /* ignore non-JSON */ }
				}
				if (cmd.type === 'network_baseline_compare') {
					try {
						const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
						processNetworkBaselineCompare(result.id, agent.id, parsed);
					} catch { /* ignore non-JSON */ }
				}
				if (cmd.type === 'boot_performance_collect') {
					try {
						const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
						processBootPerformanceResult(result.id, agent.id, parsed);
					} catch { /* ignore non-JSON */ }
				}
				if (cmd.type === 'hardware_warranty_collect') {
					try {
						const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
						processHardwareWarrantyResult(result.id, agent.id, parsed);
					} catch { /* ignore non-JSON */ }
				}
				if (cmd.type === 'cis_audit') {
					try {
						const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
						processCisAuditResult(result.id, agent.id, parsed);
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
	const agentHmacSecret = getAgentHmacSecret(agent.id);
	const binaryAdvisorySig = binaryHash && agentHmacSecret
		? signBinaryAdvisory(agent.id, binaryHash, advisoryIssuedAt, agentHmacSecret)
		: '';
	const manifestSig = binaryHash ? signManifest(agent.id, binaryHash, advisoryIssuedAt) : null;

	const rotationHistory = getManifestRotationHistory();

	// advisoryIssuedAt is part of the signed HMAC message — must match wire copy verbatim.
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
		...(manifestSig ? { binaryManifestSignature: manifestSig } : {}),
		...(rotationHistory.length > 0 ? { manifestRotationHistory: rotationHistory } : {})
	});
};
