import { db } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { recordFinding, fingerprintOf } from '$services/agent-findings.js';
import { recordCollectorResult } from '$services/agent-collector-results.js';
import { peripheralPolicySchema } from '$lib/validators-rmm.js';
import type { FindingSeverity } from '$lib/types.js';
import type { z } from 'zod';


export type PeripheralPolicy = z.infer<typeof peripheralPolicySchema>;

export interface PeripheralDevice {
	vendor: string;
	vendorId: string;
	product: string;
	productId: string;
	serialNumber: string;
	busType: 'usb' | 'thunderbolt' | 'bluetooth';
	deviceClass: 'storage' | 'hid' | 'audio' | 'network' | 'video' | 'printer' | 'unknown';
	mounted: boolean;
	mountPoint: string;
}

export interface ScanPayload {
	devices: PeripheralDevice[];
	policyVersion?: string;
}

export interface DeviceVerdict {
	action: 'allow' | 'block' | 'alert' | 'read_only';
	matchedException: PeripheralPolicy['exceptions'][number] | null;
}

const DEFAULT_POLICY: PeripheralPolicy = {
	deviceClass: 'storage',
	action: 'alert',
	exceptions: []
};


function caseEquals(a: string | undefined, b: string): boolean {
	if (!a) return true;
	return a.toLowerCase() === b.toLowerCase();
}

function exceptionExpired(ex: PeripheralPolicy['exceptions'][number]): boolean {
	if (!ex.expiresAt) return false;
	const t = Date.parse(ex.expiresAt);
	if (Number.isNaN(t)) return false;
	return Date.now() > t;
}

function classMatches(policyClass: PeripheralPolicy['deviceClass'], device: PeripheralDevice): boolean {
	if (policyClass === 'storage') return device.deviceClass === 'storage';
	if (policyClass === 'all_usb') {
		return device.busType === 'usb';
	}
	if (policyClass === 'bluetooth') return device.busType === 'bluetooth';
	if (policyClass === 'thunderbolt') return device.busType === 'thunderbolt';
	return false;
}

/**
 * Pure evaluator. Mirrors `EvaluateDevice` on the agent — both sides
 * must reach the same verdict for the same input. Server's verdict
 * drives findings; agent's verdict is informational (no kernel driver
 * means we don't actually block at the OS layer).
 */
export function evaluateDevice(device: PeripheralDevice, policy: PeripheralPolicy): DeviceVerdict {
	if (!classMatches(policy.deviceClass, device)) {
		return { action: 'allow', matchedException: null };
	}
	for (const ex of policy.exceptions) {
		if (exceptionExpired(ex)) continue;
		if (!ex.vendor && !ex.product && !ex.serialNumber) continue;
		if (!caseEquals(ex.vendor, device.vendor)) continue;
		if (!caseEquals(ex.product, device.product)) continue;
		if (!caseEquals(ex.serialNumber, device.serialNumber)) continue;
		if (ex.allow) return { action: 'allow', matchedException: ex };
	}
	return { action: policy.action, matchedException: null };
}

const stmtGetAgentData = db.prepare('SELECT data FROM agents WHERE id = ?');
const stmtUpdateAgentData = db.prepare("UPDATE agents SET data = ?, updated_at = datetime('now') WHERE id = ?");

function readAgentData(agentId: string): Record<string, unknown> | null {
	const row = stmtGetAgentData.get(agentId) as { data: string } | undefined;
	if (!row) return null;
	try { return JSON.parse(row.data) as Record<string, unknown>; } catch { return {}; }
}

export function getPolicy(agentId: string): PeripheralPolicy {
	const data = readAgentData(agentId);
	if (!data) return DEFAULT_POLICY;
	const raw = data.peripheralPolicy;
	const parsed = peripheralPolicySchema.safeParse(raw);
	return parsed.success ? parsed.data : DEFAULT_POLICY;
}

export function setPolicy(agentId: string, policy: PeripheralPolicy, userId: string): PeripheralPolicy {
	const validated = peripheralPolicySchema.parse(policy);
	return db.transaction(() => {
		const data = readAgentData(agentId);
		if (data === null) throw new Error('Agent not found: ' + agentId);
		const before = (() => {
			const parsed = peripheralPolicySchema.safeParse(data.peripheralPolicy);
			return parsed.success ? parsed.data : null;
		})();
		const next = { ...data, peripheralPolicy: validated };
		stmtUpdateAgentData.run(JSON.stringify(next), agentId);
		recordChange('agent', agentId, 'update', {
			peripheralPolicy: { old: before, new: validated }
		}, userId);
		return validated;
	})();
}

function severityForAction(action: DeviceVerdict['action']): FindingSeverity {
	switch (action) {
		case 'block': return 'high';
		case 'alert': return 'medium';
		case 'read_only': return 'medium';
		default: return 'low';
	}
}

function describeDevice(d: PeripheralDevice): string {
	const parts: string[] = [];
	if (d.vendor) parts.push(d.vendor);
	if (d.product) parts.push(d.product);
	const label = parts.join(' ').trim();
	const id = `${d.vendorId || '????'}:${d.productId || '????'}`;
	return label ? `${label} (${id})` : `USB device ${id}`;
}

export function processPeripheralScanResult(
	commandId: string,
	agentId: string,
	payload: ScanPayload
): void {
	const policy = getPolicy(agentId);
	const inventory = (payload.devices || []).map(d => ({
		...d,
		verdict: evaluateDevice(d, policy)
	}));

	db.transaction(() => {
		recordCollectorResult({
			agentId,
			commandId,
			kind: 'peripheral_inventory',
			payload: {
				devices: inventory,
				policyVersion: payload.policyVersion ?? null,
				recordedAt: new Date().toISOString()
			}
		});

		for (const item of inventory) {
			if (item.verdict.action === 'allow') continue;
			const fp = fingerprintOf('peripheral', [
				item.vendorId, item.productId, item.serialNumber, item.busType, item.deviceClass
			]);
			const title = `${describeDevice(item)} — ${item.verdict.action}`;
			recordFinding({
				agentId,
				category: 'peripheral',
				severity: severityForAction(item.verdict.action),
				title,
				evidence: {
					device: item,
					action: item.verdict.action,
					matchedException: item.verdict.matchedException
				},
				fingerprint: fp
			});
		}
	})();
}
