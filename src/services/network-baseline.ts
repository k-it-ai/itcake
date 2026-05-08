import { z } from 'zod';
import net from 'node:net';
import { db } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { recordCollectorResult, getLatestCollectorResult, listCollectorResults } from '$services/agent-collector-results.js';
import { recordFinding, fingerprintOf, listFindingsByCategory } from '$services/agent-findings.js';
import { ServiceError } from '$lib/server/service-error.js';
import { withDelta } from '$lib/server/with-delta.js';

const cidrRegex = /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/(?:[0-9]|[12][0-9]|3[0-2]))?$/;

function isValidCidrOrIp(s: string): boolean {
	if (!cidrRegex.test(s)) return false;
	const ip = s.includes('/') ? s.split('/')[0] : s;
	return net.isIP(ip) === 4;
}

export const networkScanOptionsSchema = z.object({
	subnets: z.array(z.string().min(1).max(64).refine(isValidCidrOrIp, 'subnets must be IPv4 CIDRs or IPs')).max(16).default([]),
	methods: z.array(z.enum(['arp', 'ping', 'port_scan', 'mdns'])).max(4).default(['arp', 'ping', 'port_scan', 'mdns']),
	timeoutSeconds: z.number().int().min(5).max(300).default(30),
	concurrency: z.number().int().min(1).max(256).default(32),
	portTopN: z.number().int().min(1).max(50).default(12)
});

export type NetworkScanOptions = z.infer<typeof networkScanOptionsSchema>;

export function validateNetworkScanOptions(input: unknown): NetworkScanOptions {
	return networkScanOptionsSchema.parse(input ?? {});
}

const deviceSchema = z.object({
	address: z.string().max(45).refine(s => net.isIP(s) > 0, 'invalid address'),
	mac: z.string().max(64).default(''),
	hostname: z.string().max(255).default(''),
	openPorts: z.array(z.number().int().min(0).max(65535)).max(100).default([]),
	vendor: z.string().max(255).default(''),
	lastSeen: z.string().max(100).default('')
});

export type NetworkDevice = z.infer<typeof deviceSchema>;

export const networkResultSchema = z.object({
	scannedAt: z.string().max(100).default(''),
	durationSeconds: z.number().int().min(0).default(0),
	subnetsScanned: z.array(z.string().max(64)).max(32).default([]),
	methodsUsed: z.array(z.string().max(64)).max(8).default([]),
	devices: z.array(deviceSchema).max(2000).default([]),
	truncated: z.boolean().default(false),
	errors: z.array(z.string().max(2000)).max(100).default([])
});

export type NetworkResult = z.infer<typeof networkResultSchema>;

function normMac(mac: string): string {
	return mac.trim().toLowerCase();
}

function normHostname(h: string): string {
	return h.trim().toLowerCase();
}

function deviceKey(d: NetworkDevice): string {
	const m = normMac(d.mac);
	return m ? `mac:${m}` : `address:${d.address}`;
}

export function processNetworkDiscoveryResult(
	commandId: string,
	agentId: string,
	payload: Record<string, unknown>
): { devicesRecorded: number } {
	const parsed = networkResultSchema.safeParse(payload);
	if (!parsed.success) return { devicesRecorded: 0 };
	recordCollectorResult({
		agentId,
		commandId,
		kind: 'network_discovery',
		payload: { ...parsed.data, recordedAt: new Date().toISOString() } as unknown as Record<string, unknown>
	});
	return { devicesRecorded: parsed.data.devices.length };
}

export interface NetworkDiff {
	newDevices: NetworkDevice[];
	disappeared: NetworkDevice[];
	changed: Array<{ previous: NetworkDevice; current: NetworkDevice; reason: string }>;
}

const DISAPPEARED_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function diffAgainstBaseline(scan: NetworkResult, baseline: NetworkDevice[], now: Date = new Date()): NetworkDiff {
	const delta = withDelta<NetworkDevice>(baseline, scan.devices, {
		keyOf: deviceKey,
		changeFields: [
			{ name: 'mac_changed', equals: (a, b) => !a.mac || !b.mac || normMac(a.mac) === normMac(b.mac) },
			{ name: 'hostname_changed', equals: (a, b) => !a.hostname || !b.hostname || normHostname(a.hostname) === normHostname(b.hostname) }
		]
	});

	const disappeared = delta.removed.filter((prev) => {
		const lastSeen = prev.lastSeen ? Date.parse(prev.lastSeen) : NaN;
		return !(Number.isFinite(lastSeen) && now.getTime() - lastSeen < DISAPPEARED_THRESHOLD_MS);
	});

	return {
		newDevices: delta.added,
		disappeared,
		changed: delta.changed.map((c) => ({ previous: c.previous, current: c.current, reason: c.reasons.join(',') }))
	};
}

export function processNetworkBaselineCompare(
	commandId: string,
	agentId: string,
	payload: Record<string, unknown>
): { devicesRecorded: number; findingsEmitted: number } {
	const parsed = networkResultSchema.safeParse(payload);
	if (!parsed.success) return { devicesRecorded: 0, findingsEmitted: 0 };
	const data = parsed.data;

	recordCollectorResult({
		agentId,
		commandId,
		kind: 'network_discovery',
		payload: { ...data, recordedAt: new Date().toISOString(), kindHint: 'baseline_compare' } as unknown as Record<string, unknown>
	});

	const baseline = getStoredBaseline(agentId);
	if (!baseline) {
		return { devicesRecorded: data.devices.length, findingsEmitted: 0 };
	}

	const diff = diffAgainstBaseline(data, baseline);
	let findingsEmitted = 0;

	for (const d of diff.newDevices) {
		const fp = fingerprintOf('network', [agentId, d.address, normMac(d.mac), 'new']);
		recordFinding({
			agentId,
			category: 'network',
			severity: 'medium',
			title: `New device on LAN: ${d.address}${d.mac ? ' ' + d.mac : ''}`,
			evidence: { device: d, kind: 'new_device' },
			fingerprint: fp
		});
		findingsEmitted++;
	}
	for (const d of diff.disappeared) {
		const fp = fingerprintOf('network', [agentId, d.address, normMac(d.mac), 'disappeared']);
		recordFinding({
			agentId,
			category: 'network',
			severity: 'low',
			title: `Device disappeared from LAN: ${d.address}${d.mac ? ' ' + d.mac : ''}`,
			evidence: { device: d, kind: 'device_disappeared' },
			fingerprint: fp
		});
		findingsEmitted++;
	}
	for (const c of diff.changed) {
		const fp = fingerprintOf('network', [agentId, c.current.address, normMac(c.current.mac), 'changed', c.reason]);
		recordFinding({
			agentId,
			category: 'network',
			severity: 'low',
			title: `Device ${c.current.address} changed (${c.reason})`,
			evidence: { previous: c.previous, current: c.current, reason: c.reason, kind: 'device_changed' },
			fingerprint: fp
		});
		findingsEmitted++;
	}

	return { devicesRecorded: data.devices.length, findingsEmitted };
}

function getStoredBaseline(agentId: string): NetworkDevice[] | null {
	const row = getLatestCollectorResult(agentId, 'network_baseline');
	if (!row) return null;
	const raw = (row.payload as { devices?: unknown }).devices;
	if (!Array.isArray(raw)) return null;
	const parsed = z.array(deviceSchema).safeParse(raw);
	return parsed.success ? parsed.data : null;
}

const stmtAgentExists = db.prepare('SELECT id FROM agents WHERE id = ?');

export function setNetworkBaseline(agentId: string, userId: string): { devices: number; baselineSetAt: string } {
	const exists = stmtAgentExists.get(agentId) as { id: string } | undefined;
	if (!exists) throw new ServiceError('error.notFound');

	const latest = getLatestCollectorResult(agentId, 'network_discovery');
	if (!latest) throw new Error('No network discovery result available; run a scan first');
	const raw = (latest.payload as { devices?: unknown }).devices;
	const parsed = z.array(deviceSchema).safeParse(raw);
	if (!parsed.success) throw new Error('Latest discovery result is malformed; cannot promote to baseline');

	const recordedAt = new Date().toISOString();
	db.transaction(() => {
		recordCollectorResult({
			agentId,
			commandId: null,
			kind: 'network_baseline',
			payload: { devices: parsed.data, recordedAt }
		});
		recordChange('agent', agentId, 'update', {
			networkBaseline: { old: null, new: { devices: parsed.data.length, recordedAt } }
		}, userId);
	})();

	return { devices: parsed.data.length, baselineSetAt: recordedAt };
}

export function getNetworkSnapshot(agentId: string): {
	latestDiscovery: ReturnType<typeof getLatestCollectorResult>;
	latestBaseline: ReturnType<typeof getLatestCollectorResult>;
	findings: ReturnType<typeof listFindingsByCategory>;
	historyCount: number;
} {
	const history = listCollectorResults(agentId, 'network_discovery', 50);
	return {
		latestDiscovery: getLatestCollectorResult(agentId, 'network_discovery'),
		latestBaseline: getLatestCollectorResult(agentId, 'network_baseline'),
		findings: listFindingsByCategory(agentId, 'network', 100),
		historyCount: history.length
	};
}
