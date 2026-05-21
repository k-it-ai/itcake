/**
 * Verifies the rmm.updateManifestPrivateKey credential is wired into the
 * canonical SETTINGS_CREDENTIAL_AADS map: setSetting auto-encrypts the
 * plaintext key, getSetting auto-decrypts on read, and the on-disk row
 * contains an enc3:-prefixed blob (never plaintext).
 *
 * This is the parity gate against the previously-bespoke encryption
 * path in `services/agent-auto-update.ts`, which used a separate
 * `MANIFEST_KEY_AAD` constant and ran manual encrypt/decrypt every
 * call. A future refactor that drops the canonical-map entry would
 * trip this test before the round-trip silently breaks in production.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-rmm-manifest-aad');

let setSetting: typeof import('../../src/lib/server/db.js').setSetting;
let getSetting: typeof import('../../src/lib/server/db.js').getSetting;
let SETTINGS_CREDENTIAL_AADS: typeof import('../../src/lib/server/db.js').SETTINGS_CREDENTIAL_AADS;
let db: typeof import('../../src/lib/server/db.js').db;
let getOrCreateUpdateManifestKey: typeof import('../../src/services/agent-auto-update.js').getOrCreateUpdateManifestKey;
let signManifest: typeof import('../../src/services/agent-auto-update.js').signManifest;
let isManifestKeyEncrypted: typeof import('../../src/services/agent-auto-update.js').isManifestKeyEncrypted;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'aad.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	setSetting = dbMod.setSetting;
	getSetting = dbMod.getSetting;
	SETTINGS_CREDENTIAL_AADS = dbMod.SETTINGS_CREDENTIAL_AADS;
	db = dbMod.db;
	const auto = await import('../../src/services/agent-auto-update.js');
	getOrCreateUpdateManifestKey = auto.getOrCreateUpdateManifestKey;
	signManifest = auto.signManifest;
	isManifestKeyEncrypted = auto.isManifestKeyEncrypted;
});

beforeEach(() => {
	setSetting('rmm', {
		defaultCheckinInterval: 30,
		staleThresholdMinutes: 2,
		metricsRetentionHours: 48,
		commandTimeoutSeconds: 300
	});
});

describe('rmm.updateManifestPrivateKey canonical AAD wiring', () => {
	it('SETTINGS_CREDENTIAL_AADS includes rmm.updateManifestPrivateKey', () => {
		expect(SETTINGS_CREDENTIAL_AADS['rmm.updateManifestPrivateKey']).toBe('rmm.updateManifestPrivateKey:1');
	});

	it('on-disk row stores the key enc3:-prefixed after generate', () => {
		getOrCreateUpdateManifestKey();
		expect(isManifestKeyEncrypted()).toBe(true);
		const row = db.prepare("SELECT value FROM settings WHERE key = 'rmm'").get() as { value: string } | undefined;
		expect(row).toBeTruthy();
		const parsed = JSON.parse(row!.value) as { updateManifestPrivateKey?: string };
		expect(parsed.updateManifestPrivateKey).toMatch(/^enc3:/);
	});

	it('getSetting decrypts the at-rest blob — caller sees plaintext base64 PKCS#8', () => {
		getOrCreateUpdateManifestKey();
		const rmm = getSetting<{ updateManifestPrivateKey?: string }>('rmm');
		expect(rmm.updateManifestPrivateKey).toBeTruthy();
		// Plaintext path: not enc-prefixed, parseable as base64 → DER.
		expect(rmm.updateManifestPrivateKey!.startsWith('enc')).toBe(false);
		const der = Buffer.from(rmm.updateManifestPrivateKey!, 'base64');
		// Ed25519 PKCS#8 DER is 48 bytes (16-byte header + 32-byte key).
		expect(der.length).toBe(48);
	});

	it('signManifest works against the auto-encrypted blob (round-trip)', () => {
		getOrCreateUpdateManifestKey();
		const sig = signManifest('agent-1', 'h'.repeat(64), '2026-05-20T00:00:00Z');
		expect(sig).not.toBeNull();
		expect(Buffer.from(sig!, 'base64').length).toBe(64);
	});

	it('writing plaintext via setSetting auto-encrypts on the way to disk', () => {
		// Simulate a different caller writing a fresh plaintext key — the
		// `encryptSettingsFields` rmm branch must encrypt before storing.
		const rmm = getSetting<{ updateManifestPrivateKey?: string }>('rmm');
		setSetting('rmm', { ...rmm, updateManifestPrivateKey: 'PLAINTEXTFAKEKEYBASE64' });
		const row = db.prepare("SELECT value FROM settings WHERE key = 'rmm'").get() as { value: string };
		const parsed = JSON.parse(row.value) as { updateManifestPrivateKey?: string };
		expect(parsed.updateManifestPrivateKey).toMatch(/^enc3:/);
		// And the next read decrypts back to the plaintext.
		const roundTripped = getSetting<{ updateManifestPrivateKey?: string }>('rmm');
		expect(roundTripped.updateManifestPrivateKey).toBe('PLAINTEXTFAKEKEYBASE64');
	});
});
