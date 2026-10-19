import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

// Round-3 reviewer flagged: /api/agents/update-manifest-key needs explicit
// regression coverage that the MFA step-up gate denies missing/bad codes
// and accepts a valid TOTP. Mirrors the per-call check in
// `src/routes/api/agents/update-manifest-key/+server.ts`.

const TEST_DIR = path.resolve('data-test-manifest-key-stepup');

let db: typeof import('../../src/lib/server/db.js').db;
let initMfa: typeof import('../../src/services/auth-mfa.js').initMfa;
let enableMfa: typeof import('../../src/services/auth-mfa.js').enableMfa;
let disableMfa: typeof import('../../src/services/auth-mfa.js').disableMfa;
let totp: typeof import('../../src/lib/server/totp.js').totp;
let removeUpdateManifestKey: typeof import('../../src/services/agent-auto-update.js').removeUpdateManifestKey;
let POST: typeof import('../../src/routes/api/agents/update-manifest-key/+server.js').POST;

const USER_ID = 'user-manifest-stepup';

let totpSecret: string;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'manifest-stepup.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const mfaMod = await import('../../src/services/auth-mfa.js');
	const totpMod = await import('../../src/lib/server/totp.js');
	const updMod = await import('../../src/services/agent-auto-update.js');
	const routeMod = await import('../../src/routes/api/agents/update-manifest-key/+server.js');

	db = dbMod.db;
	initMfa = mfaMod.initMfa;
	enableMfa = mfaMod.enableMfa;
	disableMfa = mfaMod.disableMfa;
	totp = totpMod.totp;
	removeUpdateManifestKey = updMod.removeUpdateManifestKey;
	POST = routeMod.POST;

	const hash = await bcrypt.hash('Pass1234', 4);
	db.prepare('DELETE FROM users WHERE id = ?').run(USER_ID);
	db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
		.run(USER_ID, 'manifest-stepup@local', 'M', hash);

	const init = initMfa('manifest-stepup@local');
	totpSecret = init.secret;
	enableMfa(USER_ID, init.secret, totp(init.secret), init.recoveryCodes);
});

function callPost(body: Record<string, unknown>): Promise<Response> {
	const req = new Request('http://localhost/api/agents/update-manifest-key', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	const locals = { user: { id: USER_ID, role: 'admin' } } as unknown as App.Locals;
	// The route expects a SvelteKit RequestEvent; we only use `request` and `locals`.
	return (POST as unknown as (e: { request: Request; locals: App.Locals }) => Promise<Response>)({
		request: req,
		locals
	});
}

async function expectStatus(body: Record<string, unknown>, status: number): Promise<void> {
	try {
		const res = await callPost(body);
		expect(res.status).toBe(status);
	} catch (e) {
		const err = e as { status?: number };
		expect(err.status).toBe(status);
	}
}

describe('POST /api/agents/update-manifest-key step-up gate', () => {
	beforeEach(() => {
		// Each test must take the "no key configured yet → step-up required"
		// branch in the route handler. Clear both the replay cache and any
		// previously-generated key so successive cases all hit the gate.
		db.prepare('DELETE FROM mfa_step_up_used_codes').run();
		removeUpdateManifestKey();
	});

	it('rejects with 403 when MFA is enabled and no mfaCode is supplied (generate)', async () => {
		await expectStatus({ action: 'generate' }, 403);
	});

	it('rejects with 401 when an invalid mfaCode is supplied (generate)', async () => {
		await expectStatus({ action: 'generate', mfaCode: '000000' }, 401);
	});

	it('passes with a valid TOTP code (generate)', async () => {
		const code = totp(totpSecret);
		const res = await callPost({ action: 'generate', mfaCode: code });
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(typeof json.publicKeyB64).toBe('string');
	});

	it('disable MFA again so subsequent tests run unaffected', () => {
		disableMfa(USER_ID);
		const status = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(USER_ID) as
			| { totp_enabled: number }
			| undefined;
		expect(status?.totp_enabled).toBe(0);
	});
});
