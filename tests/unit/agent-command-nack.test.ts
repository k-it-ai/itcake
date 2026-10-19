/**
 * Server-side transient-nack handling.
 *
 * The agent tracks redelivery locally and nacks with `transient: true` while
 * its worker pool is full. The server bounds that loop: each transient nack
 * bumps `nack_count` while the command is pending, and the command is marked
 * failed once the cap is reached. A final result arriving afterwards must not
 * resurrect it — the two retry views (agent window, server cap) stay aligned.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-agent-command-nack');

let db: typeof import('../../src/lib/server/db.js').db;
let processCommandResult: typeof import('../../src/services/agent-commands.js').processCommandResult;
let getCommand: typeof import('../../src/services/agent-commands.js').getCommand;
let maxNacks: number;

const AGENT = 'agent-nack-test';

function seedCommand(id: string): void {
	db.prepare(
		"INSERT INTO agent_commands (id, agent_id, type, user_id) VALUES (?, ?, 'shell', 'u-nack-test')"
	).run(id, AGENT);
}

function nackCount(id: string): number {
	const row = db.prepare('SELECT nack_count FROM agent_commands WHERE id = ?').get(id) as { nack_count: number };
	return row.nack_count;
}

const transientResult = {
	status: 'failed' as const,
	exitCode: null,
	stdout: '',
	stderr: 'worker pool busy',
	startedAt: null,
	completedAt: null,
	transient: true
};

beforeAll(async () => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATA_DIR = TEST_DIR;
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'nack.db');
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	db = (await import('../../src/lib/server/db.js')).db;
	const mod = await import('../../src/services/agent-commands.js');
	processCommandResult = mod.processCommandResult;
	getCommand = mod.getCommand;
	maxNacks = mod.MAX_TRANSIENT_NACKS;
	db.prepare(
		"INSERT INTO agents (id, name, hostname, os, arch, token_hash, status, enabled, data) VALUES (?, 'Nack', 'h', 'linux', 'amd64', ?, 'online', 1, '{}')"
	).run(AGENT, 'tok-nack-test');
});

describe('transient nacks', () => {
	it('keeps the command pending below the cap and fails it at the cap', () => {
		seedCommand('cmd-below-cap');
		for (let i = 1; i < maxNacks; i++) {
			processCommandResult('cmd-below-cap', AGENT, transientResult);
			expect(nackCount('cmd-below-cap')).toBe(i);
			expect(getCommand('cmd-below-cap')!.status).toBe('pending');
		}
		processCommandResult('cmd-below-cap', AGENT, transientResult);
		const cmd = getCommand('cmd-below-cap')!;
		expect(cmd.status).toBe('failed');
		expect(cmd.stderr).toContain('persistently overloaded');
	});

	it('ignores a late final result after the server failed the command', () => {
		processCommandResult('cmd-below-cap', AGENT, {
			status: 'completed', exitCode: 0, stdout: 'too late', stderr: '', startedAt: null, completedAt: null
		});
		const cmd = getCommand('cmd-below-cap')!;
		expect(cmd.status).toBe('failed');
		expect(cmd.stdout).toBe('');
	});

	it('will not nack a command that already reached a final state', () => {
		seedCommand('cmd-done');
		processCommandResult('cmd-done', AGENT, {
			status: 'completed', exitCode: 0, stdout: 'ok', stderr: '', startedAt: null, completedAt: null
		});
		processCommandResult('cmd-done', AGENT, transientResult);
		expect(nackCount('cmd-done')).toBe(0);
		expect(getCommand('cmd-done')!.status).toBe('completed');
	});
});
