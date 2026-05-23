/**
 * POST /api/rmm/enroll includes the current Ed25519 manifest pubkey when
 * the operator has generated one. Agents capture this on first enrol and
 * persist it encrypted in their config, so a local attacker who wipes the
 * ITCAKE_UPDATE_MANIFEST_PUBKEYS env var cannot silently downgrade to
 * advisory-only update verification.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-rmm-enroll-manifest');

let POST: typeof import('../../src/routes/api/rmm/enroll/+server.js').POST;
let createEnrollmentToken: typeof import('../../src/services/agents.js').createEnrollmentToken;
let getOrCreateUpdateManifestKey: typeof import('../../src/services/agent-auto-update.js').getOrCreateUpdateManifestKey;

const HMAC = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'enroll.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	POST = (await import('../../src/routes/api/rmm/enroll/+server.js')).POST;
	const agents = await import('../../src/services/agents.js');
	createEnrollmentToken = agents.createEnrollmentToken;
	const upd = await import('../../src/services/agent-auto-update.js');
	getOrCreateUpdateManifestKey = upd.getOrCreateUpdateManifestKey;

	// Seed an admin user so createEnrollmentToken can be invoked.
	const db = (await import('../../src/lib/server/db.js')).db;
	db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)`).run(
		'admin-user', 'admin@test', 'hash'
	);
});

async function enroll(body: Record<string, unknown>) {
	const req = new Request('http://localhost/api/rmm/enroll', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	return await POST({
		request: req,
		getClientAddress: () => '127.0.0.1'
	} as Parameters<typeof POST>[0]);
}

describe('POST /api/rmm/enroll includes manifest pubkey', () => {
	it('omits manifestPubKey when no keypair is configured', async () => {
		const tok = createEnrollmentToken('agent-no-key', 'admin-user');
		const res = await enroll({
			token: tok.token,
			hostname: 'host-no-key',
			os: 'linux',
			arch: 'amd64',
			osVersion: '',
			agentVersion: '',
			hmacSecret: HMAC
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body).not.toHaveProperty('manifestPubKey');
	});

	it('includes manifestPubKey when keypair has been generated', async () => {
		const { publicKeyB64 } = getOrCreateUpdateManifestKey();
		expect(publicKeyB64).toBeTruthy();
		const tok = createEnrollmentToken('agent-with-key', 'admin-user');
		const res = await enroll({
			token: tok.token,
			hostname: 'host-with-key',
			os: 'linux',
			arch: 'amd64',
			osVersion: '',
			agentVersion: '',
			hmacSecret: HMAC
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.manifestPubKey).toBe(publicKeyB64);
	});
});
