import { describe, it, expect } from 'vitest';
import {
	agentRemoteDesktopSchema,
	remoteDesktopSettingsSchema
} from '../../src/lib/validators-rmm.js';

describe('agentRemoteDesktopSchema', () => {
	it('rejects a profile without host (empty/missing)', () => {
		const missing = agentRemoteDesktopSchema.safeParse({ protocol: 'rdp', port: 3389 });
		expect(missing.success).toBe(false);
		const empty = agentRemoteDesktopSchema.safeParse({ protocol: 'rdp', host: '', port: 3389 });
		expect(empty.success).toBe(false);
		const whitespace = agentRemoteDesktopSchema.safeParse({ protocol: 'rdp', host: '   ', port: 3389 });
		expect(whitespace.success).toBe(false);
	});

	it('accepts an explicit host (operator-set, not agent-reported)', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'rdp', host: '10.0.0.5', port: 3389
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.host).toBe('10.0.0.5');
	});

	it('accepts a fully-specified RDP profile', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'rdp', host: '10.0.0.5', port: 3389,
			username: 'Administrator', password: 'pa$$',
			domain: 'corp.local', ignoreCert: true, recording: true
		});
		expect(r.success).toBe(true);
	});

	it('accepts SSH with a private key', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'ssh', host: 'agent.lan', port: 22, username: 'root',
			privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key\n-----END OPENSSH PRIVATE KEY-----'
		});
		expect(r.success).toBe(true);
	});

	it('rejects unknown protocol', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'telnet', port: 23
		});
		expect(r.success).toBe(false);
	});

	it('rejects out-of-range port', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'rdp', port: 0
		});
		expect(r.success).toBe(false);
	});

	it('rejects oversize private key', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'ssh', port: 22,
			privateKey: 'x'.repeat(20001)
		});
		expect(r.success).toBe(false);
	});

	it('rejects host longer than 255 chars', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'rdp', host: 'x'.repeat(256), port: 3389
		});
		expect(r.success).toBe(false);
	});
});

describe('claimRemoteSessionStart (atomic one-shot)', () => {
	it('only one of two parallel claims wins', async () => {
		const path = await import('node:path');
		const fs = await import('node:fs');
		const TEST_DIR = path.resolve('data-test-rd-claim');
		if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
		fs.mkdirSync(TEST_DIR, { recursive: true });
		process.env.DATABASE_PATH = path.join(TEST_DIR, 'rd.db');
		process.env.DATA_DIR = TEST_DIR;
		const { randomBytes } = await import('node:crypto');
		process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

		const dbMod = await import('../../src/lib/server/db.js');
		const rs = await import('../../src/services/remote-sessions.js');

		dbMod.db.prepare('DELETE FROM remote_sessions').run();
		dbMod.db.prepare('DELETE FROM agents').run();
		dbMod.db.prepare('DELETE FROM users').run();
		dbMod.db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('u1', 'u1@test.com', 'u1', 'x')").run();
		dbMod.db.prepare(
			"INSERT INTO agents (id, name, hostname, os, arch, token_hash, status, data, last_seen_at) " +
			"VALUES ('agent-claim-1', 'a1', 'h1', 'linux', 'amd64', 'h', 'online', '{}', datetime('now'))"
		).run();
		const issued = rs.createRemoteSession({
			agentId: 'agent-claim-1',
			userId: 'u1',
			protocol: 'rdp',
			ttlSeconds: 60,
			clientIp: '127.0.0.1',
			userAgent: 'vitest'
		});

		const first = rs.claimRemoteSessionStart(issued.sessionId, '/recordings/x');
		const second = rs.claimRemoteSessionStart(issued.sessionId, '/recordings/x');
		expect(first).toBe(true);
		expect(second).toBe(false);
	});
});

describe('remoteDesktopSettingsSchema', () => {
	it('accepts the seeded defaults', () => {
		const r = remoteDesktopSettingsSchema.safeParse({
			enabled: false,
			guacdHost: '127.0.0.1', guacdPort: 4822,
			proxyPort: 4823,
			recordingEnabled: false,
			maxSessionMinutes: 60,
			tokenTtlSeconds: 300
		});
		expect(r.success).toBe(true);
	});

	it('rejects proxyPort < 1024 (privileged)', () => {
		const r = remoteDesktopSettingsSchema.safeParse({
			enabled: true, guacdHost: '127.0.0.1', guacdPort: 4822,
			proxyPort: 80, recordingEnabled: false,
			maxSessionMinutes: 60, tokenTtlSeconds: 300
		});
		expect(r.success).toBe(false);
	});

	it('rejects tokenTtlSeconds outside bounds', () => {
		const r = remoteDesktopSettingsSchema.safeParse({
			enabled: true, guacdHost: '127.0.0.1', guacdPort: 4822,
			proxyPort: 4823, recordingEnabled: false,
			maxSessionMinutes: 60, tokenTtlSeconds: 0
		});
		expect(r.success).toBe(false);
	});

	it('rejects maxSessionMinutes > 24h', () => {
		const r = remoteDesktopSettingsSchema.safeParse({
			enabled: true, guacdHost: '127.0.0.1', guacdPort: 4822,
			proxyPort: 4823, recordingEnabled: false,
			maxSessionMinutes: 1500, tokenTtlSeconds: 300
		});
		expect(r.success).toBe(false);
	});
});
