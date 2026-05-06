import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto, { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-update-manifest');

let getOrCreateUpdateManifestKey: typeof import('../../src/services/agent-auto-update.js').getOrCreateUpdateManifestKey;
let rotateUpdateManifestKey: typeof import('../../src/services/agent-auto-update.js').rotateUpdateManifestKey;
let removeUpdateManifestKey: typeof import('../../src/services/agent-auto-update.js').removeUpdateManifestKey;
let signManifest: typeof import('../../src/services/agent-auto-update.js').signManifest;
let isManifestKeyEncrypted: typeof import('../../src/services/agent-auto-update.js').isManifestKeyEncrypted;
let getUpdateManifestPublicKey: typeof import('../../src/services/agent-auto-update.js').getUpdateManifestPublicKey;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'manifest.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const m = await import('../../src/services/agent-auto-update.js');
	getOrCreateUpdateManifestKey = m.getOrCreateUpdateManifestKey;
	rotateUpdateManifestKey = m.rotateUpdateManifestKey;
	removeUpdateManifestKey = m.removeUpdateManifestKey;
	signManifest = m.signManifest;
	isManifestKeyEncrypted = m.isManifestKeyEncrypted;
	getUpdateManifestPublicKey = m.getUpdateManifestPublicKey;
	setSetting = (await import('../../src/lib/server/db.js')).setSetting;
});

beforeEach(() => {
	// Reset to a known-empty rmm setting before each test so the
	// generate/rotate/remove flow exercises freshly each time.
	setSetting('rmm', {
		defaultCheckinInterval: 30,
		staleThresholdMinutes: 2,
		metricsRetentionHours: 48,
		commandTimeoutSeconds: 300
	});
});

// Mirrors the agent-side VerifyManifestSignature in
// agent/internal/updater/pubkeys.go. Tiny, deliberately duplicated so
// the test would catch a server-vs-agent message-format drift.
function verifyManifestAgentSide(
	pubKeyB64: string,
	agentId: string,
	binaryHash: string,
	issuedAt: string,
	signatureB64: string
): boolean {
	const rawPub = Buffer.from(pubKeyB64, 'base64');
	if (rawPub.length !== 32) return false;
	const sig = Buffer.from(signatureB64, 'base64');
	if (sig.length !== 64) return false;

	// Wrap raw 32-byte ed25519 pubkey in DER SPKI so node's crypto API can verify.
	const spkiPrefix = Buffer.from([
		0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
	]);
	const der = Buffer.concat([spkiPrefix, rawPub]);
	const pubKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
	const message = Buffer.from(`binary-manifest:${agentId}:${binaryHash}:${issuedAt}`, 'utf8');
	return crypto.verify(null, message, pubKey, sig);
}

describe('update-manifest signing', () => {
	it('generates a keypair on first call and reuses it on second', () => {
		const a = getOrCreateUpdateManifestKey();
		expect(a.publicKeyB64).toBeTruthy();
		expect(Buffer.from(a.publicKeyB64, 'base64').length).toBe(32);

		const b = getOrCreateUpdateManifestKey();
		expect(b.publicKeyB64).toBe(a.publicKeyB64);
	});

	it('stores the private key encrypted at rest', () => {
		getOrCreateUpdateManifestKey();
		expect(isManifestKeyEncrypted()).toBe(true);
	});

	it('rotate replaces the keypair', () => {
		const before = getOrCreateUpdateManifestKey();
		const after = rotateUpdateManifestKey();
		expect(after.publicKeyB64).not.toBe(before.publicKeyB64);
		expect(getUpdateManifestPublicKey()).toBe(after.publicKeyB64);
	});

	it('remove clears the stored key', () => {
		getOrCreateUpdateManifestKey();
		expect(getUpdateManifestPublicKey()).toBeTruthy();
		removeUpdateManifestKey();
		expect(getUpdateManifestPublicKey()).toBeNull();
	});

	it('signManifest returns null when no key is configured', () => {
		removeUpdateManifestKey();
		const sig = signManifest('agent-1', 'deadbeef', '2026-05-06T00:00:00Z');
		expect(sig).toBeNull();
	});

	it('agent-side verify accepts a server-signed manifest', () => {
		const { publicKeyB64 } = getOrCreateUpdateManifestKey();
		const agentId = 'agent-1';
		const binaryHash = 'b'.repeat(64);
		const issuedAt = '2026-05-06T12:34:56Z';
		const sig = signManifest(agentId, binaryHash, issuedAt);
		expect(sig).not.toBeNull();
		expect(verifyManifestAgentSide(publicKeyB64, agentId, binaryHash, issuedAt, sig!)).toBe(true);
	});

	it('agent-side verify rejects a tampered binary hash', () => {
		const { publicKeyB64 } = getOrCreateUpdateManifestKey();
		const agentId = 'agent-1';
		const issuedAt = '2026-05-06T12:34:56Z';
		const sig = signManifest(agentId, 'good-hash', issuedAt);
		expect(sig).not.toBeNull();
		expect(verifyManifestAgentSide(publicKeyB64, agentId, 'BAD-hash', issuedAt, sig!)).toBe(false);
	});

	it('agent-side verify rejects a tampered issuedAt', () => {
		const { publicKeyB64 } = getOrCreateUpdateManifestKey();
		const sig = signManifest('agent-1', 'h', '2026-05-06T12:00:00Z');
		expect(sig).not.toBeNull();
		expect(verifyManifestAgentSide(publicKeyB64, 'agent-1', 'h', '2026-05-06T13:00:00Z', sig!)).toBe(false);
	});

	it('agent-side verify rejects a wrong-agent signature', () => {
		const { publicKeyB64 } = getOrCreateUpdateManifestKey();
		const sig = signManifest('agent-A', 'h', '2026-05-06T12:00:00Z');
		expect(sig).not.toBeNull();
		expect(verifyManifestAgentSide(publicKeyB64, 'agent-B', 'h', '2026-05-06T12:00:00Z', sig!)).toBe(false);
	});

	it('after rotate, signatures from the old key are rejected by the new pubkey', () => {
		const a = getOrCreateUpdateManifestKey();
		const oldSig = signManifest('agent-1', 'h', '2026-05-06T12:00:00Z');
		const b = rotateUpdateManifestKey();
		expect(a.publicKeyB64).not.toBe(b.publicKeyB64);
		expect(verifyManifestAgentSide(b.publicKeyB64, 'agent-1', 'h', '2026-05-06T12:00:00Z', oldSig!)).toBe(false);
		const newSig = signManifest('agent-1', 'h', '2026-05-06T12:00:00Z');
		expect(verifyManifestAgentSide(b.publicKeyB64, 'agent-1', 'h', '2026-05-06T12:00:00Z', newSig!)).toBe(true);
	});
});
