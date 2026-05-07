import { recordCollectorResult, getLatestCollectorResult } from '$services/agent-collector-results.js';
import { recordFinding, fingerprintOf } from '$services/agent-findings.js';
import { getAgentDataRaw, updateAgent } from '$services/agents.js';
import { db } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';

export type WarrantyStatus = 'active' | 'expiring' | 'expired' | 'unknown';

export interface HardwareSnapshot {
	manufacturer: string;
	model: string;
	serialNumber: string;
	biosVersion: string;
	biosDate: string;
	chassisType: string;
	warrantyEndDate: string;
	warrantyLabel: string;
	warrantySource: string;
	collectedAt: string;
}

export interface WarrantyOverride {
	warrantyEndDate?: string;
	purchaseDate?: string;
	notes?: string;
	updatedAt?: string;
	updatedBy?: string;
}

export interface WarrantyView {
	snapshot: HardwareSnapshot | null;
	override: WarrantyOverride | null;
	effectiveEndDate: string | null;
	effectiveSource: 'override' | 'detected' | null;
	status: WarrantyStatus;
	daysRemaining: number | null;
}

const WARN_DAYS = 90;
const CRITICAL_DAYS = 30;

function asString(v: unknown): string {
	return typeof v === 'string' ? v.slice(0, 200) : '';
}

function parseDate(s: string | undefined | null): Date | null {
	if (!s) return null;
	const t = Date.parse(s);
	if (!Number.isFinite(t)) return null;
	return new Date(t);
}

function parsePayload(raw: Record<string, unknown>): HardwareSnapshot {
	return {
		manufacturer: asString(raw.manufacturer),
		model: asString(raw.model),
		serialNumber: asString(raw.serialNumber),
		biosVersion: asString(raw.biosVersion),
		biosDate: asString(raw.biosDate),
		chassisType: asString(raw.chassisType),
		warrantyEndDate: asString(raw.warrantyEndDate),
		warrantyLabel: asString(raw.warrantyLabel),
		warrantySource: asString(raw.warrantySource),
		collectedAt: asString(raw.collectedAt) || new Date().toISOString()
	};
}

export function processHardwareWarrantyResult(
	commandId: string,
	agentId: string,
	payload: Record<string, unknown>
): void {
	const snap = parsePayload(payload);
	if (!snap.manufacturer && !snap.model && !snap.serialNumber) return;
	recordCollectorResult({
		agentId,
		commandId,
		kind: 'hardware_warranty',
		payload: snap as unknown as Record<string, unknown>
	});
	evaluateWarrantyFinding(agentId);
}

function readOverride(agentId: string): WarrantyOverride | null {
	const data = getAgentDataRaw(agentId);
	if (!data) return null;
	const wo = data.warrantyOverride;
	if (!wo || typeof wo !== 'object') return null;
	const v = wo as Record<string, unknown>;
	return {
		warrantyEndDate: asString(v.warrantyEndDate) || undefined,
		purchaseDate: asString(v.purchaseDate) || undefined,
		notes: asString(v.notes) || undefined,
		updatedAt: asString(v.updatedAt) || undefined,
		updatedBy: asString(v.updatedBy) || undefined
	};
}

function readSnapshot(agentId: string): HardwareSnapshot | null {
	const r = getLatestCollectorResult(agentId, 'hardware_warranty');
	return r ? parsePayload(r.payload) : null;
}

export function getWarranty(agentId: string): WarrantyView {
	const snapshot = readSnapshot(agentId);
	const override = readOverride(agentId);

	const overrideDate = parseDate(override?.warrantyEndDate);
	const detectedDate = parseDate(snapshot?.warrantyEndDate);
	const effective = overrideDate ?? detectedDate;
	const effectiveSource: WarrantyView['effectiveSource'] = overrideDate ? 'override' : detectedDate ? 'detected' : null;

	let status: WarrantyStatus = 'unknown';
	let daysRemaining: number | null = null;
	if (effective) {
		const diffMs = effective.getTime() - Date.now();
		daysRemaining = Math.floor(diffMs / 86400_000);
		if (daysRemaining < 0) status = 'expired';
		else if (daysRemaining <= WARN_DAYS) status = 'expiring';
		else status = 'active';
	}

	return {
		snapshot,
		override,
		effectiveEndDate: effective ? effective.toISOString().slice(0, 10) : null,
		effectiveSource,
		status,
		daysRemaining
	};
}

export function setWarrantyOverride(
	agentId: string,
	override: { warrantyEndDate?: string; purchaseDate?: string; notes?: string },
	userId: string
): WarrantyView {
	const data = getAgentDataRaw(agentId) ?? {};
	const sanitised: WarrantyOverride = {
		warrantyEndDate: override.warrantyEndDate ? String(override.warrantyEndDate).slice(0, 10) : undefined,
		purchaseDate: override.purchaseDate ? String(override.purchaseDate).slice(0, 10) : undefined,
		notes: override.notes ? String(override.notes).slice(0, 500) : undefined,
		updatedAt: new Date().toISOString(),
		updatedBy: userId
	};

	if (sanitised.warrantyEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(sanitised.warrantyEndDate)) {
		throw new Error('warrantyEndDate must be YYYY-MM-DD');
	}
	if (sanitised.purchaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(sanitised.purchaseDate)) {
		throw new Error('purchaseDate must be YYYY-MM-DD');
	}

	const next = { ...data, warrantyOverride: sanitised };
	db.transaction(() => {
		db.prepare("UPDATE agents SET data = ? WHERE id = ?").run(JSON.stringify(next), agentId);
		recordChange('agent', agentId, 'update', { warrantyOverride: { old: data.warrantyOverride ?? null, new: sanitised } }, userId);
	})();
	// Touch the agent record so its updated_at moves forward — keeps the
	// updateAgent path's invariants consistent with the cache.
	updateAgent(agentId, {}, userId);

	evaluateWarrantyFinding(agentId);
	return getWarranty(agentId);
}

function evaluateWarrantyFinding(agentId: string): void {
	const view = getWarranty(agentId);
	if (view.status === 'unknown' || view.daysRemaining === null) return;

	let severity: 'low' | 'medium' | 'high' | 'critical' | null = null;
	let title = '';
	if (view.status === 'expired') {
		severity = 'high';
		title = `Hardware warranty expired (${Math.abs(view.daysRemaining)}d ago)`;
	} else if (view.daysRemaining <= CRITICAL_DAYS) {
		severity = 'medium';
		title = `Warranty expires in ${view.daysRemaining}d`;
	} else if (view.daysRemaining <= WARN_DAYS) {
		severity = 'low';
		title = `Warranty expires in ${view.daysRemaining}d`;
	}

	if (severity === null) return;
	recordFinding({
		agentId,
		category: 'policy',
		severity,
		title,
		evidence: {
			warrantyEndDate: view.effectiveEndDate,
			source: view.effectiveSource,
			manufacturer: view.snapshot?.manufacturer ?? '',
			model: view.snapshot?.model ?? '',
			serialNumber: view.snapshot?.serialNumber ?? '',
			daysRemaining: view.daysRemaining
		},
		fingerprint: fingerprintOf('policy', ['warranty-window', agentId, view.effectiveEndDate])
	});
}
