/**
 * Live macOS/Linux/Windows agent smoke test.
 *
 * Builds the real Go agent binary, enrolls it against a running production
 * server, starts it in the foreground, and verifies:
 *   - enrollment succeeds and writes a config
 *   - the agent's initial check-in reaches the server
 *   - a dispatched read-only command executes and its result is recorded
 *
 * This closes the "the Go agent was never run" review gap. It requires Go on
 * PATH; otherwise the suite skips. The agent talks plain HTTP to loopback,
 * which is allowed only with ITCAKE_ALLOW_HTTP=1 (dev/test escape hatch).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	startProductionServer, freshDataDir, cleanupDir, jsonCall, cookieFrom,
	isCommandAvailable, setupAdmin, sleep, type LiveServer
} from './helpers';

const BACKEND_PORT = 5503;
const DATA_DIR = freshDataDir('agent-smoke');
const AGENT_ROOT = path.resolve('agent');
const AGENT_BIN = path.join(DATA_DIR, process.platform === 'win32' ? 'itcake-agent.exe' : 'itcake-agent');
const AGENT_CONFIG = path.join(DATA_DIR, 'agent-config.json');
const EMAIL = 'agent-smoke@example.com';
const hasGo = isCommandAvailable('go');

let server: LiveServer;
let cookie = '';
let agentProcess: ChildProcess | null = null;
let enrolledAgentId = '';

function buildAgent(): void {
	const res = spawnSync('go', ['build', '-o', AGENT_BIN, './cmd/agent'], {
		cwd: AGENT_ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf-8'
	});
	if (res.status !== 0) {
		throw new Error(`go build failed:\n${res.stdout}\n${res.stderr}`);
	}
	if (!existsSync(AGENT_BIN)) throw new Error('go build produced no binary');
}

function runAgent(args: string[], timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(AGENT_BIN, args, {
			env: { ...process.env, ITCAKE_ALLOW_HTTP: '1' },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (c) => { stdout += c.toString(); });
		child.stderr?.on('data', (c) => { stderr += c.toString(); });
		const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
		child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
	});
}

beforeAll(async () => {
	if (!hasGo) throw new Error('SKIP: go is not installed');
	mkdirSync(DATA_DIR, { recursive: true });
	buildAgent();
	server = await startProductionServer({
		port: BACKEND_PORT,
		dataDir: DATA_DIR,
		base: `http://127.0.0.1:${BACKEND_PORT}`
	});
	cookie = await setupAdmin(server, EMAIL);
}, 180_000);

afterAll(async () => {
	if (agentProcess) {
		agentProcess.kill('SIGKILL');
		agentProcess = null;
	}
	await server?.stop();
	cleanupDir(DATA_DIR);
});

describe.skipIf(!hasGo)('Go agent smoke test', () => {
	it('enrolls the real agent binary against the production server', async () => {
		const tokenRes = await jsonCall(server, 'POST', '/api/agents/enrollment-tokens', { name: 'smoke-agent' }, { cookie });
		expect(tokenRes.status).toBe(201);
		const token = tokenRes.data.token as string;
		expect(token).toBeTruthy();

		const enroll = await runAgent([
			'enroll',
			'--server', `http://127.0.0.1:${BACKEND_PORT}`,
			'--token', token,
			'--config', AGENT_CONFIG
		]);
		expect(enroll.code, `enroll failed:\n${enroll.stdout}\n${enroll.stderr}`).toBe(0);
		expect(enroll.stdout).toContain('Enrolled successfully');
		expect(existsSync(AGENT_CONFIG)).toBe(true);

		const idMatch = enroll.stdout.match(/\(ID: ([^)]+)\)/);
		expect(idMatch, `could not parse agent ID from enrollment output:\n${enroll.stdout}`).toBeTruthy();
		enrolledAgentId = idMatch![1];

		const agents = await jsonCall(server, 'GET', '/api/agents', undefined, { cookie });
		expect(agents.status).toBe(200);
		const list = agents.data as unknown as Array<Record<string, unknown>>;
		expect(list.length).toBeGreaterThanOrEqual(1);
		expect(list.some((a) => String(a.name ?? '').includes('smoke'))).toBe(true);
	}, 120_000);

	it('checks in and receives a dispatched read-only command', async () => {
		const agents = await jsonCall(server, 'GET', '/api/agents', undefined, { cookie });
		const list = agents.data as unknown as Array<Record<string, unknown>>;
		const agent = list.find((a) => String(a.id) === enrolledAgentId)!;
		expect(agent, `enrolled agent ${enrolledAgentId} not found in /api/agents`).toBeTruthy();
		const agentId = enrolledAgentId;

		// Enrollment writes checkinInterval=60. The test needs the agent to poll
		// faster so a dispatched command lands well inside the assertion window.
		const cfg = JSON.parse(readFileSync(AGENT_CONFIG, 'utf-8')) as { checkinInterval?: number };
		cfg.checkinInterval = 2;
		writeFileSync(AGENT_CONFIG, JSON.stringify(cfg), { mode: 0o600 });

		// Start the agent. Its Run() loop performs an immediate check-in, then
		// polls for commands on the configured interval.
		agentProcess = spawn(AGENT_BIN, ['run', '--config', AGENT_CONFIG], {
			env: { ...process.env, ITCAKE_ALLOW_HTTP: '1' },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const agentLogs: string[] = [];
		agentProcess.stdout?.on('data', (c) => { agentLogs.push(c.toString()); });
		agentProcess.stderr?.on('data', (c) => { agentLogs.push(c.toString()); });

		// Enrollment already inserts status='online', so status is not a reliable
		// check-in signal. Wait for the check-in timestamp to advance instead.
		// Sleep past the current second first: last_seen_at uses SQLite's
		// second-precision datetime('now'), and enrollment + agent start can
		// easily land in the same second.
		const initialLastSeen = String(agent.lastSeenAt ?? '');
		await sleep(1100);

		let checkedIn = false;
		for (let i = 0; i < 40; i++) {
			const current = await jsonCall(server, 'GET', '/api/agents', undefined, { cookie });
			const row = (current.data as unknown as Array<Record<string, unknown>>).find((a) => a.id === agentId);
			if (row && String(row.lastSeenAt ?? '') !== initialLastSeen) {
				checkedIn = true;
				break;
			}
			await sleep(500);
		}
		expect(checkedIn, `agent never checked in:\n${agentLogs.join('')}\nserver:\n${server.logs.slice(-40).join('\n')}`).toBe(true);

		// Dispatch a harmless read-only command.
		const dispatch = await jsonCall(server, 'POST', `/api/agents/${agentId}/commands`, {
			type: 'system_info_refresh',
			payload: {},
			timeoutSeconds: 30
		}, { cookie });
		expect(dispatch.status).toBe(201);
		const commandId = String(dispatch.data.id);

		let completed = false;
		let result: Record<string, unknown> = {};
		let exited: number | null = null;
		let lastSeenStatus = 'not-found-in-history';
		// The server's RMM settings override the agent's configured interval
		// (default 30s), so after receiving the command the agent sleeps ~30s
		// before its next check-in reports the result. Wait long enough for
		// that cycle plus the inventory budget.
		for (let i = 0; i < 120; i++) {
			await sleep(500);
			// A crashed/exited agent can never report a result — fail fast with
			// its captured output instead of waiting out the whole window.
			if (agentProcess.exitCode !== null) {
				exited = agentProcess.exitCode;
				break;
			}
			const history = await jsonCall(server, 'GET', `/api/agents/${agentId}/commands?limit=10`, undefined, { cookie });
			const rows = history.data as unknown as Array<Record<string, unknown>>;
			const row = rows.find((r) => r.id === commandId);
			if (row) {
				lastSeenStatus = String(row.status);
				if (row.status === 'completed' || row.status === 'failed') {
					completed = true;
					result = row;
					break;
				}
			}
		}
		expect(exited, `agent process exited early (code ${exited}):\n${agentLogs.join('')}`).toBe(null);
		expect(
			completed,
			`command never completed (dbStatus=${lastSeenStatus}):\n${agentLogs.join('')}\nserver:\n${server.logs.slice(-60).join('\n')}`
		).toBe(true);
		expect(result.status).toBe('completed');
	}, 120_000);
});
