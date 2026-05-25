/**
 * Worker-pool transient-nack protocol (loop-15 #9).
 *
 * Agent reports `transient: true` when its worker pool is queue-full
 * instead of `failed`. Server bumps `nack_count`, leaves status='pending'
 * so the next checkin redelivers. After MAX_TRANSIENT_NACKS attempts the
 * server gives up and marks the command failed — closes the silent-drop
 * hole where a 10k command burst would lose 9,984 commands as `failed`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-transient-nack');

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'tn.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
});

async function seedAgent(id: string): Promise<void> {
	const db = (await import('../../src/lib/server/db.js')).db;
	const { encryptField } = await import('../../src/lib/server/field-crypto.js');
	const hmacSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
	const enc = encryptField(hmacSecret, `agent.hmacSecret:${id}`);
	db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash) VALUES ('u-tn', 'tn@t', 'h')`).run();
	db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, enabled, status, token_hash, hmac_secret)
		VALUES (?, ?, ?, 'linux', 'amd64', 1, 'online', 'h-' || ?, ?)`).run(id, id, id, id, enc);
}

describe('worker-pool transient-nack', () => {
	it('transient=true leaves status pending and bumps nack_count', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const cmd = await import('../../src/services/agent-commands.js');
		await seedAgent('a-tn-1');

		const dispatched = cmd.dispatchCommand('a-tn-1', 'system_info_refresh', {}, 'u-tn');

		cmd.processCommandResult(dispatched.id, 'a-tn-1', {
			status: 'failed', exitCode: -1, stdout: '', stderr: 'queue full',
			startedAt: null, completedAt: null,
			transient: true
		});

		const row = db.prepare(`SELECT status, nack_count FROM agent_commands WHERE id = ?`).get(dispatched.id) as { status: string; nack_count: number };
		expect(row.status).toBe('pending');
		expect(row.nack_count).toBe(1);
	});

	it('MAX_TRANSIENT_NACKS+1 attempts finally marks the command failed', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const cmd = await import('../../src/services/agent-commands.js');
		await seedAgent('a-tn-2');

		const dispatched = cmd.dispatchCommand('a-tn-2', 'system_info_refresh', {}, 'u-tn');

		for (let i = 0; i < cmd.MAX_TRANSIENT_NACKS; i++) {
			cmd.processCommandResult(dispatched.id, 'a-tn-2', {
				status: 'failed', exitCode: -1, stdout: '', stderr: 'q',
				startedAt: null, completedAt: null,
				transient: true
			});
		}

		const row = db.prepare(`SELECT status, stderr, nack_count FROM agent_commands WHERE id = ?`).get(dispatched.id) as { status: string; stderr: string; nack_count: number };
		expect(row.status).toBe('failed');
		expect(row.stderr).toContain('persistently overloaded');
		expect(row.nack_count).toBe(cmd.MAX_TRANSIENT_NACKS);
	});

	it('non-transient failed result still marks completed (backward compat)', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const cmd = await import('../../src/services/agent-commands.js');
		await seedAgent('a-tn-3');

		const dispatched = cmd.dispatchCommand('a-tn-3', 'system_info_refresh', {}, 'u-tn');

		cmd.processCommandResult(dispatched.id, 'a-tn-3', {
			status: 'failed', exitCode: 1, stdout: '', stderr: 'real failure',
			startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
		});

		const row = db.prepare(`SELECT status, stderr FROM agent_commands WHERE id = ?`).get(dispatched.id) as { status: string; stderr: string };
		expect(row.status).toBe('failed');
		expect(row.stderr).toBe('real failure');
	});

	it('transient followed by a real completion marks completed (interleaving)', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const cmd = await import('../../src/services/agent-commands.js');
		await seedAgent('a-tn-4');

		const dispatched = cmd.dispatchCommand('a-tn-4', 'system_info_refresh', {}, 'u-tn');

		// First attempt: queue full, nacked.
		cmd.processCommandResult(dispatched.id, 'a-tn-4', {
			status: 'failed', exitCode: -1, stdout: '', stderr: 'q',
			startedAt: null, completedAt: null,
			transient: true
		});

		// Second attempt: actually executes.
		cmd.processCommandResult(dispatched.id, 'a-tn-4', {
			status: 'completed', exitCode: 0, stdout: 'ok', stderr: '',
			startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
		});

		const row = db.prepare(`SELECT status, stdout, nack_count FROM agent_commands WHERE id = ?`).get(dispatched.id) as { status: string; stdout: string; nack_count: number };
		expect(row.status).toBe('completed');
		expect(row.stdout).toBe('ok');
		expect(row.nack_count).toBe(1); // history preserved
	});

	it('transient nack from WRONG agent does NOT bump nack_count', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const cmd = await import('../../src/services/agent-commands.js');
		await seedAgent('a-tn-5-victim');
		await seedAgent('a-tn-5-attacker');

		const dispatched = cmd.dispatchCommand('a-tn-5-victim', 'system_info_refresh', {}, 'u-tn');

		cmd.processCommandResult(dispatched.id, 'a-tn-5-attacker', {
			status: 'failed', exitCode: -1, stdout: '', stderr: '',
			startedAt: null, completedAt: null,
			transient: true
		});

		const row = db.prepare(`SELECT status, nack_count FROM agent_commands WHERE id = ?`).get(dispatched.id) as { status: string; nack_count: number };
		expect(row.status).toBe('pending');
		expect(row.nack_count).toBe(0);
	});
});
