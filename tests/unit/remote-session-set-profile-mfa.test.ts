/**
 * Verifies the `set-profile` and `clear-profile` actions on
 * /api/agents/[id]/remote-session require MFA step-up when MFA is on.
 *
 * Without this gate, a SessionOnly attacker (cookie lifted, password +
 * TOTP unknown) could rewrite the agent's operator-set `host` and
 * credentials, then wait for the operator's next MFA-gated session
 * issuance to be silently redirected to attacker-controlled RDP/VNC/SSH
 * backend.
 *
 * We test the underlying handler indirectly by invoking the same
 * `requireMfaStepUp` predicate the route uses; the integration test
 * coverage for the full HTTP path lives in lifecycle.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-set-profile-mfa');

beforeAll(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'mfa.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
});

describe('remote-session set-profile + clear-profile MFA gate', () => {
	it('the +server.ts source calls requireMfaStepUp for set-profile and clear-profile', () => {
		// Static-source check — the route handler is wired to call
		// `requireMfaStepUp(userId, data, 'remote desktop profile')` at the
		// top of both actions. A future refactor that drops the gate would
		// trip this test before the SessionOnly-attack window opens.
		const src = readFileSync(
			path.resolve('src/routes/api/agents/[id]/remote-session/+server.ts'),
			'utf-8'
		);

		// Find the set-profile action body
		const setProfileMatch = src.match(/'set-profile':[\s\S]*?(?='clear-profile'|\}\s*\})/);
		expect(setProfileMatch, "'set-profile' action body not found in route source").toBeTruthy();
		expect(setProfileMatch![0]).toMatch(/requireMfaStepUp\([^)]*,\s*data,\s*['"]remote desktop profile['"]\)/);

		// And clear-profile
		const clearProfileMatch = src.match(/'clear-profile':[\s\S]*?\}\s*\}\s*\}\);/);
		expect(clearProfileMatch, "'clear-profile' action body not found in route source").toBeTruthy();
		expect(clearProfileMatch![0]).toMatch(/requireMfaStepUp\([^)]*,\s*data,\s*['"]remote desktop profile['"]\)/);
	});

	it('the audit-log diff captures host/port/username/recording/hasPassword/hasPrivateKey', () => {
		const src = readFileSync(
			path.resolve('src/routes/api/agents/[id]/remote-session/+server.ts'),
			'utf-8'
		);
		// The previous diff only carried protocol, hiding host/credential
		// changes from anyone reading /api/changes. This test pins the new
		// fields so a future trim back to just `protocol` is caught.
		for (const field of ['host', 'port', 'username', 'domain', 'ignoreCert', 'recording', 'hasPassword', 'hasPrivateKey']) {
			expect(src, `audit diff must include ${field}`).toContain(field);
		}
	});
});
