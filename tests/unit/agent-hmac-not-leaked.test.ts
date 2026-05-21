import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-agent-hmac-leak');

let getAgent: typeof import('../../src/services/agents.js').getAgent;
let getAgents: typeof import('../../src/services/agents.js').getAgents;
let enrollAgent: typeof import('../../src/services/agents.js').enrollAgent;
let createEnrollmentToken: typeof import('../../src/services/agents.js').createEnrollmentToken;
let getAgentHmacSecret: typeof import('../../src/lib/server/agent-auth.js').getAgentHmacSecret;
let authenticateAgent: typeof import('../../src/lib/server/agent-auth.js').authenticateAgent;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'agents.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const agents = await import('../../src/services/agents.js');
	getAgent = agents.getAgent;
	getAgents = agents.getAgents;
	enrollAgent = agents.enrollAgent;
	createEnrollmentToken = agents.createEnrollmentToken;
	const auth = await import('../../src/lib/server/agent-auth.js');
	getAgentHmacSecret = auth.getAgentHmacSecret;
	authenticateAgent = auth.authenticateAgent;
});

// 64 hex chars with all 16 distinct digits — passes the entropy check.
const HMAC = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function enroll(name: string, hostname: string) {
	const tok = createEnrollmentToken(name, 'tester');
	return enrollAgent(tok.token, {
		hostname,
		os: 'linux',
		arch: 'amd64',
		osVersion: '5',
		agentVersion: '0',
		hmacSecret: HMAC
	}, '203.0.113.1', 'ua');
}

describe('Agent HMAC secret confidentiality', () => {
	it('rowToAgent (via getAgent) does NOT include hmacSecret on the returned object', () => {
		const { agent } = enroll('hmac-leak-1', 'host-1');
		const fetched = getAgent(agent.id);
		expect(fetched).toBeTruthy();
		// `hmacSecret` is intentionally absent from the Agent shape. Older
		// versions of `rowToAgent` decrypted the at-rest blob into this
		// field, leaking the per-agent HMAC secret to every JSON-serialising
		// endpoint and SvelteKit page-load.
		expect((fetched as unknown as Record<string, unknown>).hmacSecret).toBeUndefined();
		expect('hmacSecret' in (fetched as object)).toBe(false);
	});

	it('getAgents() never includes hmacSecret on any returned agent', () => {
		enroll('hmac-leak-2', 'host-2');
		const all = getAgents();
		expect(all.length).toBeGreaterThan(0);
		for (const a of all) {
			expect((a as unknown as Record<string, unknown>).hmacSecret).toBeUndefined();
		}
	});

	it('authenticateAgent (bearer path) does NOT carry hmacSecret on the returned Agent', () => {
		const { bearerToken } = enroll('hmac-leak-3', 'host-3');
		const fakeRequest = new Request('https://example/api/rmm/checkin', {
			headers: { authorization: `Bearer ${bearerToken}` }
		});
		const authed = authenticateAgent(fakeRequest);
		expect(authed).toBeTruthy();
		expect((authed as unknown as Record<string, unknown>).hmacSecret).toBeUndefined();
	});

	it('getAgentHmacSecret returns the decrypted secret for the privileged read path', () => {
		const { agent } = enroll('hmac-leak-4', 'host-4');
		const secret = getAgentHmacSecret(agent.id);
		expect(secret).toBe(HMAC);
	});

	it('getAgentHmacSecret returns "" for unknown agent', () => {
		expect(getAgentHmacSecret('no-such-id')).toBe('');
	});
});
