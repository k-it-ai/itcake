/**
 * POST /api/agents/update-manifest-key {action: 'rotate'} signs the new
 * pubkey with the OLD private key, stores the signed announcement in
 * settings, and includes it on subsequent /api/rmm/checkin responses.
 *
 * Without this propagation, every agent enrolled BEFORE the rotation
 * permanently loses self-update (their persisted trust set still has
 * the old pubkey; the new manifest signature won't verify). With the
 * announcement, each agent processes the rotation on its next checkin
 * — preserving the documented runbook's operational guarantee.
 *
 * The announcement chain-of-trust: the signature is computed by the
 * PREVIOUS Ed25519 private key, so a bearer-only or HMAC-compromised
 * attacker cannot substitute a malicious pubkey. The attacker would
 * need the now-discarded previous private key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createPublicKey, verify as edVerify } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-manifest-rotation');

let rotateUpdateManifestKey: typeof import('../../src/services/agent-auto-update.js').rotateUpdateManifestKey;
let getOrCreateUpdateManifestKey: typeof import('../../src/services/agent-auto-update.js').getOrCreateUpdateManifestKey;
let getManifestRotationHistory: typeof import('../../src/services/agent-auto-update.js').getManifestRotationHistory;
let removeUpdateManifestKey: typeof import('../../src/services/agent-auto-update.js').removeUpdateManifestKey;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'mr.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const upd = await import('../../src/services/agent-auto-update.js');
	rotateUpdateManifestKey = upd.rotateUpdateManifestKey;
	getOrCreateUpdateManifestKey = upd.getOrCreateUpdateManifestKey;
	getManifestRotationHistory = upd.getManifestRotationHistory;
	removeUpdateManifestKey = upd.removeUpdateManifestKey;
});

describe('manifest-key rotation propagation', () => {
	it('first generate produces NO rotation announcement (no previous key to sign)', () => {
		removeUpdateManifestKey();
		getOrCreateUpdateManifestKey();
		const hist = getManifestRotationHistory();
		expect(hist.length).toBe(0);
	});

	it('rotate after generate produces an announcement signed by the OLD private key', () => {
		removeUpdateManifestKey();
		const initial = getOrCreateUpdateManifestKey();
		const previousPubKeyB64 = initial.publicKeyB64;

		const rotated = rotateUpdateManifestKey();
		expect(rotated.rotationAnnouncement).not.toBeNull();
		expect(rotated.publicKeyB64).not.toBe(previousPubKeyB64);

		const hist = getManifestRotationHistory();
		expect(hist.length).toBe(1);
		const ann = hist[0];
		expect(ann.pubKey).toBe(rotated.publicKeyB64);
		expect(ann.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		// The signature must verify under the PREVIOUS pubkey. Build a public-key
		// object from the previous SPKI for Node's crypto.verify.
		const prevSpkiDer = Buffer.from(previousPubKeyB64, 'base64');
		// Previous key was stored as raw 32 bytes (Ed25519). createPublicKey
		// accepts a raw-public-key import via { key: rawBytes, format: 'raw',
		// type: 'spki', namedCurve: ... } in older Node versions; modern Node
		// accepts pubKey + asymmetricKeyType. Use the explicit JWK approach:
		const previousPub = createPublicKey({
			key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(prevSpkiDer).toString('base64url') },
			format: 'jwk'
		});

		const msg = Buffer.from(`manifest-pubkey-rotation:${ann.pubKey}:${ann.issuedAt}`, 'utf8');
		const sigBytes = Buffer.from(ann.sig, 'base64');
		const ok = edVerify(null, msg, previousPub, sigBytes);
		expect(ok).toBe(true);
	});

	it('subsequent rotations prepend to history (most-recent-first) up to the cap', () => {
		removeUpdateManifestKey();
		getOrCreateUpdateManifestKey();
		// 6 rotations total to exceed the cap of 5. Tiny delay between each
		// so issuedAt timestamps strictly increase — lets us assert the full
		// emit ORDER instead of just hist[0]. Agent code iterates from
		// hist[len-1] to hist[0] (oldest-first); if the server ever swaps to
		// append-on-rotate, this test catches it because the assertion below
		// requires issuedAt[0] > issuedAt[1] > ... (most-recent-first).
		const pubkeys: string[] = [];
		const issuedAts: string[] = [];
		for (let i = 0; i < 6; i++) {
			const r = rotateUpdateManifestKey();
			pubkeys.push(r.publicKeyB64);
			issuedAts.push(r.rotationAnnouncement!.issuedAt);
			// Cheap deterministic delay — date strings round to ms, and
			// some quick CI rotations produced identical ms timestamps.
			const t0 = Date.now();
			while (Date.now() === t0) { /* spin one ms */ }
		}
		const hist = getManifestRotationHistory();
		expect(hist.length).toBe(5);
		// hist[0] is the LATEST rotation.
		expect(hist[0].pubKey).toBe(pubkeys[pubkeys.length - 1]);
		// hist[i].issuedAt must strictly decrease as i increases —
		// pins the wire-emit ORDER agents depend on for chained-rotation
		// processing. A refactor that swaps prepend for append breaks this.
		for (let i = 1; i < hist.length; i++) {
			expect(hist[i - 1].issuedAt > hist[i].issuedAt).toBe(true);
		}
		// The very first rotation (now at position cap=5) must have aged out.
		expect(hist.map((h) => h.pubKey)).not.toContain(pubkeys[0]);
	});

	it('remove clears the rotation history so a fresh generate starts clean', () => {
		removeUpdateManifestKey();
		getOrCreateUpdateManifestKey();
		rotateUpdateManifestKey();
		expect(getManifestRotationHistory().length).toBeGreaterThan(0);

		removeUpdateManifestKey();
		expect(getManifestRotationHistory().length).toBe(0);
	});
});
