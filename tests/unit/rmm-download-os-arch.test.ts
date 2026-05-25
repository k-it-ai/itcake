/**
 * /api/rmm/download/[os]/[arch] enforces that a bearer-authenticated agent
 * may only download its own OS/arch binary. Operator (cookie) downloads stay
 * unrestricted. Without this check, a compromised Linux bearer could
 * enumerate Windows binaries (supply-chain pivot).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-rmm-download-os-arch');

let enrollAgent: typeof import('../../src/services/agents.js').enrollAgent;
let createEnrollmentToken: typeof import('../../src/services/agents.js').createEnrollmentToken;
let GET: typeof import('../../src/routes/api/rmm/download/[os]/[arch]/+server.js').GET;

const HMAC = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'agent-binaries'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'rdoa.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const agents = await import('../../src/services/agents.js');
	enrollAgent = agents.enrollAgent;
	createEnrollmentToken = agents.createEnrollmentToken;
	const mod = await import('../../src/routes/api/rmm/download/[os]/[arch]/+server.js');
	GET = mod.GET;
});

function enroll(name: string, hostname: string, os: string, arch: string) {
	const tok = createEnrollmentToken(name);
	return enrollAgent(tok.token, {
		hostname,
		os,
		arch,
		osVersion: '',
		agentVersion: '',
		hmacSecret: HMAC
	}, '127.0.0.1');
}

async function callDownload(opts: { os: string; arch: string; bearer?: string; userId?: string }) {
	const headers = new Headers();
	if (opts.bearer) headers.set('Authorization', `Bearer ${opts.bearer}`);
	const req = new Request(`http://localhost/api/rmm/download/${opts.os}/${opts.arch}`, { headers });
	const locals = { user: opts.userId ? { id: opts.userId } : undefined } as Parameters<typeof GET>[0]['locals'];
	return await GET({
		params: { os: opts.os, arch: opts.arch },
		locals,
		request: req
	} as Parameters<typeof GET>[0]);
}

describe('GET /api/rmm/download/[os]/[arch] — OS/arch enforcement for bearer auth', () => {
	it('rejects a Linux agent requesting the Windows binary', async () => {
		const { bearerToken } = enroll('linux-1', 'linux-host', 'linux', 'amd64');
		const res = await callDownload({ os: 'windows', arch: 'amd64', bearer: bearerToken });
		expect(res.status).toBe(403);
	});

	it('rejects a Linux agent requesting a different Linux arch', async () => {
		const { bearerToken } = enroll('linux-2', 'linux-host-2', 'linux', 'amd64');
		const res = await callDownload({ os: 'linux', arch: 'arm64', bearer: bearerToken });
		expect(res.status).toBe(403);
	});

	it('rejects unauthenticated downloads', async () => {
		const res = await callDownload({ os: 'linux', arch: 'amd64' });
		expect(res.status).toBe(401);
	});

	it('rejects requests with an invalid OS or arch literal', async () => {
		const { bearerToken } = enroll('linux-3', 'linux-host-3', 'linux', 'amd64');
		const r1 = await callDownload({ os: 'bogus', arch: 'amd64', bearer: bearerToken });
		expect(r1.status).toBe(400);
		const r2 = await callDownload({ os: 'linux', arch: 'sparc', bearer: bearerToken });
		expect(r2.status).toBe(400);
	});

	it('X-Binary-SHA256 + Content-Digest match the SHA-256 of the served body bytes', async () => {
		const { bearerToken } = enroll('linux-hash', 'linux-host-hash', 'linux', 'amd64');
		const binPath = path.join(TEST_DIR, 'agent-binaries', 'itcake-agent-linux-amd64');
		const planted = Buffer.from('fake-agent-binary-bytes-for-hash-test-' + 'x'.repeat(512));
		writeFileSync(binPath, planted);

		const res = await callDownload({ os: 'linux', arch: 'amd64', bearer: bearerToken });
		expect(res.status).toBe(200);
		const headerHash = res.headers.get('X-Binary-SHA256');
		const digest = res.headers.get('Content-Digest');
		expect(headerHash).toBeTruthy();
		expect(digest).toBeTruthy();

		const body = Buffer.from(await res.arrayBuffer());
		const actual = createHash('sha256').update(body).digest('hex');
		expect(headerHash).toBe(actual);

		const expectedB64 = Buffer.from(actual, 'hex').toString('base64');
		expect(digest).toBe(`sha-256=:${expectedB64}:`);
	});
});
