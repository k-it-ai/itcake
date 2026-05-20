import crypto from 'node:crypto';
import { db, parseSqliteUtc, getSetting, setSetting } from '$lib/server/db.js';
import { dispatchCommand } from './agent-commands.js';
import { encryptField, decryptFieldStrict, isEncryptedField } from '$lib/server/field-crypto.js';
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

// ----- Ed25519 update-manifest signing -----
//
// The agent's HMAC-keyed advisory already protects the binary hash with
// a per-agent shared secret. The Ed25519 layer is additive: when the
// operator has generated a server-side keypair AND deployed the public
// key into the agent's ITCAKE_UPDATE_MANIFEST_PUBKEYS env var, the
// agent additionally requires this signature before it will fetch the
// new binary. With no key configured, signManifest returns null and
// the existing flow is unchanged.
//
// The private key is stored in `settings.rmm.updateManifestPrivateKey`
// as a base64 PKCS#8 blob, encrypted via field-crypto with the v3 AAD
// `rmm.updateManifestPrivateKey:1`. The "1" suffix anchors the AAD to
// a fixed identity (singleton key) so a future cross-row migration
// can't silently substitute it for a different setting's blob.

const MANIFEST_KEY_AAD = 'rmm.updateManifestPrivateKey:1';

type ManifestKeyMaterial = {
	publicKeyB64: string;
	/** PKCS#8-encoded base64 private key, plaintext (caller is responsible for encryption). */
	privateKeyB64Plain: string;
};

function generateKeypair(): ManifestKeyMaterial {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
	const pubDer = publicKey.export({ format: 'der', type: 'spki' });
	// Strip the 12-byte SPKI prefix so we emit the raw 32-byte
	// Ed25519 public key the agent's pubkey loader expects.
	const rawPub = pubDer.subarray(pubDer.length - 32);
	const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
	return {
		publicKeyB64: rawPub.toString('base64'),
		privateKeyB64Plain: privDer.toString('base64')
	};
}

function getRmmSettings(): RmmSettings & { updateManifestPrivateKey?: string; updateManifestPublicKey?: string } {
	return getSetting<RmmSettings & { updateManifestPrivateKey?: string; updateManifestPublicKey?: string }>('rmm');
}

function readPrivateKey(rmm: { updateManifestPrivateKey?: string }): crypto.KeyObject | null {
	const enc = rmm.updateManifestPrivateKey;
	if (!enc) return null;
	const plain = decryptFieldStrict(enc, MANIFEST_KEY_AAD);
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

/**
 * Lazily generates the keypair on first call. Subsequent calls return
 * the existing public key. Stores the private key encrypted at rest.
 */
export function getOrCreateUpdateManifestKey(): { publicKeyB64: string } {
	const rmm = getRmmSettings();
	if (rmm.updateManifestPrivateKey && rmm.updateManifestPublicKey) {
		return { publicKeyB64: rmm.updateManifestPublicKey };
	}
	const k = generateKeypair();
	const ciphertext = encryptField(k.privateKeyB64Plain, MANIFEST_KEY_AAD);
	const next = { ...rmm, updateManifestPrivateKey: ciphertext, updateManifestPublicKey: k.publicKeyB64 };
	setSetting('rmm', next);
	return { publicKeyB64: k.publicKeyB64 };
}

export function rotateUpdateManifestKey(): { publicKeyB64: string } {
	const rmm = getRmmSettings();
	const k = generateKeypair();
	const ciphertext = encryptField(k.privateKeyB64Plain, MANIFEST_KEY_AAD);
	const next = { ...rmm, updateManifestPrivateKey: ciphertext, updateManifestPublicKey: k.publicKeyB64 };
	setSetting('rmm', next);
	return { publicKeyB64: k.publicKeyB64 };
}

export function removeUpdateManifestKey(): void {
	const rmm = getRmmSettings();
	const next: Record<string, unknown> = { ...rmm };
	delete next.updateManifestPrivateKey;
	delete next.updateManifestPublicKey;
	setSetting('rmm', next);
}

/**
 * Signs `binary-manifest:<agentId>:<binaryHash>:<issuedAt>` with the
 * configured Ed25519 private key. Returns base64. Returns null when no
 * keypair has been generated; callers must treat that as "skip the
 * signature field" so the agent's no-keys-configured path stays
 * backward compatible.
 */
export function signManifest(agentId: string, binaryHash: string, issuedAt: string): string | null {
	const rmm = getRmmSettings();
	if (!rmm.updateManifestPrivateKey) return null;
	const key = readPrivateKey(rmm);
	if (!key) return null;
	const message = Buffer.from(`binary-manifest:${agentId}:${binaryHash}:${issuedAt}`, 'utf8');
	const sig = crypto.sign(null, message, key);
	return sig.toString('base64');
}

export function isManifestKeyEncrypted(): boolean {
	const rmm = getRmmSettings();
	return !!rmm.updateManifestPrivateKey && isEncryptedField(rmm.updateManifestPrivateKey);
}
