import crypto from 'node:crypto';
import { db, parseSqliteUtc, getSetting, setSetting } from '$lib/server/db.js';
import { dispatchCommand } from './agent-commands.js';
import type { RmmSettings } from '$lib/types.js';

export type AutoUpdateAgent = {
	id: string;
	status: 'online' | 'offline' | 'stale' | 'pending';
	enabled: boolean;
	autoUpdateSoftware: boolean;
	autoUpdateOS: boolean;
	autoUpdateIntervalHours: number;
	lastAutoUpdateAt: string | null;
};

export function computeAutoUpdateDispatch(
	agents: AutoUpdateAgent[],
	now: number = Date.now()
): Array<{ agentId: string; type: 'software_update' | 'os_update' }> {
	const out: Array<{ agentId: string; type: 'software_update' | 'os_update' }> = [];
	for (const a of agents) {
		if (!a.enabled) continue;
		if (a.status === 'offline') continue;
		if (!a.autoUpdateSoftware && !a.autoUpdateOS) continue;

		const intervalHours = a.autoUpdateIntervalHours > 0 ? a.autoUpdateIntervalHours : 24;
		const intervalMs = intervalHours * 60 * 60 * 1000;

		const lastMs = a.lastAutoUpdateAt ? parseSqliteUtc(a.lastAutoUpdateAt) : 0;
		if (now - lastMs < intervalMs) continue;

		if (a.autoUpdateSoftware) out.push({ agentId: a.id, type: 'software_update' });
		if (a.autoUpdateOS) out.push({ agentId: a.id, type: 'os_update' });
	}
	return out;
}

const stmtGetCandidates = db.prepare(
	`SELECT id, status, enabled, data, last_auto_update_at
	 FROM agents
	 WHERE enabled = 1 AND status != 'offline'`
);
const stmtMarkDispatched = db.prepare(
	"UPDATE agents SET last_auto_update_at = datetime('now') WHERE id = ?"
);

export function processAutoUpdates(now: number = Date.now()): number {
	const rows = stmtGetCandidates.all() as Array<{
		id: string;
		status: 'online' | 'offline' | 'stale' | 'pending';
		enabled: number;
		data: string;
		last_auto_update_at: string | null;
	}>;

	const input: AutoUpdateAgent[] = rows.map(r => {
		let d: Record<string, unknown> = {};
		try { d = JSON.parse(r.data); } catch { /* corrupt → no auto-update */ }
		return {
			id: r.id,
			status: r.status,
			enabled: r.enabled === 1,
			autoUpdateSoftware: d.autoUpdateSoftware === true,
			autoUpdateOS: d.autoUpdateOS === true,
			autoUpdateIntervalHours: typeof d.autoUpdateIntervalHours === 'number' ? d.autoUpdateIntervalHours : 24,
			lastAutoUpdateAt: r.last_auto_update_at
		};
	});

	const decisions = computeAutoUpdateDispatch(input, now);
	const dispatchedAgents = new Set<string>();
	for (const d of decisions) {
		try {
			const timeout = d.type === 'os_update' ? 1800 : 600;
			dispatchCommand(d.agentId, d.type, {}, 'system', timeout);
			dispatchedAgents.add(d.agentId);
		} catch (e) {
			console.error(`[auto-update] ${d.type} dispatch failed for ${d.agentId}:`, e instanceof Error ? e.message : e);
		}
	}
	for (const id of dispatchedAgents) {
		stmtMarkDispatched.run(id);
	}
	return dispatchedAgents.size;
}

type ManifestKeyMaterial = {
	publicKeyB64: string;
	/** PKCS#8-encoded base64 private key, plaintext. */
	privateKeyB64Plain: string;
};

function generateKeypair(): ManifestKeyMaterial {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
	const pubDer = publicKey.export({ format: 'der', type: 'spki' });
	// Strip 12-byte SPKI prefix to emit the raw 32-byte Ed25519 pubkey the agent expects.
	const rawPub = pubDer.subarray(pubDer.length - 32);
	const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
	return {
		publicKeyB64: rawPub.toString('base64'),
		privateKeyB64Plain: privDer.toString('base64')
	};
}

export interface ManifestRotationAnnouncement {
	pubKey: string;
	sig: string;
	issuedAt: string;
}

interface RmmInternalSettings extends RmmSettings {
	updateManifestPrivateKey?: string;
	updateManifestPublicKey?: string;
	updateManifestRotationHistory?: ManifestRotationAnnouncement[];
}

function getRmmSettings(): RmmInternalSettings {
	return getSetting<RmmInternalSettings>('rmm');
}

const MANIFEST_ROTATION_HISTORY_CAP = 5;

function loadPrivateKey(rmm: { updateManifestPrivateKey?: string }): crypto.KeyObject | null {
	const plain = rmm.updateManifestPrivateKey;
	if (!plain) return null;
	const der = Buffer.from(plain, 'base64');
	try {
		return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
	} catch {
		return null;
	}
}

export function getUpdateManifestPublicKey(): string | null {
	const rmm = getRmmSettings();
	return rmm.updateManifestPublicKey || null;
}

export function getOrCreateUpdateManifestKey(): { publicKeyB64: string } {
	const rmm = getRmmSettings();
	if (rmm.updateManifestPrivateKey && rmm.updateManifestPublicKey) {
		return { publicKeyB64: rmm.updateManifestPublicKey };
	}
	const k = generateKeypair();
	const next = { ...rmm, updateManifestPrivateKey: k.privateKeyB64Plain, updateManifestPublicKey: k.publicKeyB64 };
	setSetting('rmm', next);
	return { publicKeyB64: k.publicKeyB64 };
}

export function rotateUpdateManifestKey(): { publicKeyB64: string; rotationAnnouncement: ManifestRotationAnnouncement | null } {
	const rmm = getRmmSettings();
	const newKeypair = generateKeypair();
	const issuedAt = new Date().toISOString();

	let announcement: ManifestRotationAnnouncement | null = null;
	const oldKey = loadPrivateKey(rmm);
	if (oldKey) {
		const msg = Buffer.from(`manifest-pubkey-rotation:${newKeypair.publicKeyB64}:${issuedAt}`, 'utf8');
		const sig = crypto.sign(null, msg, oldKey).toString('base64');
		announcement = { pubKey: newKeypair.publicKeyB64, sig, issuedAt };
	}

	const history = Array.isArray(rmm.updateManifestRotationHistory)
		? rmm.updateManifestRotationHistory.filter((a): a is ManifestRotationAnnouncement => !!a && typeof a.pubKey === 'string' && typeof a.sig === 'string' && typeof a.issuedAt === 'string')
		: [];
	const nextHistory = announcement
		? [announcement, ...history].slice(0, MANIFEST_ROTATION_HISTORY_CAP)
		: history;

	const next: RmmInternalSettings = {
		...rmm,
		updateManifestPrivateKey: newKeypair.privateKeyB64Plain,
		updateManifestPublicKey: newKeypair.publicKeyB64,
		updateManifestRotationHistory: nextHistory
	};
	setSetting('rmm', next);
	return { publicKeyB64: newKeypair.publicKeyB64, rotationAnnouncement: announcement };
}

export function getManifestRotationHistory(): ManifestRotationAnnouncement[] {
	const rmm = getRmmSettings();
	const hist = rmm.updateManifestRotationHistory;
	if (!Array.isArray(hist)) return [];
	return hist.filter((a): a is ManifestRotationAnnouncement => !!a && typeof a.pubKey === 'string' && typeof a.sig === 'string' && typeof a.issuedAt === 'string');
}

export function removeUpdateManifestKey(): void {
	const rmm = getRmmSettings();
	const next: Record<string, unknown> = { ...rmm };
	delete next.updateManifestPrivateKey;
	delete next.updateManifestPublicKey;
	delete next.updateManifestRotationHistory;
	setSetting('rmm', next);
}

export function signManifest(agentId: string, binaryHash: string, issuedAt: string): string | null {
	const rmm = getRmmSettings();
	if (!rmm.updateManifestPrivateKey) return null;
	const key = loadPrivateKey(rmm);
	if (!key) return null;
	const message = Buffer.from(`binary-manifest:${agentId}:${binaryHash}:${issuedAt}`, 'utf8');
	const sig = crypto.sign(null, message, key);
	return sig.toString('base64');
}

// Reads the raw row (NOT getSetting) to assert the at-rest enc3: prefix.
export function isManifestKeyEncrypted(): boolean {
	const row = db.prepare("SELECT value FROM settings WHERE key = 'rmm'").get() as { value: string } | undefined;
	if (!row) return false;
	try {
		const parsed = JSON.parse(row.value) as { updateManifestPrivateKey?: string };
		const v = parsed?.updateManifestPrivateKey;
		return typeof v === 'string' && /^enc\d*:/.test(v);
	} catch {
		return false;
	}
}
