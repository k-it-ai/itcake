/**
 * Regression tests for the guacamole-lite integration.
 *
 * The live guacd test caught three API-shape bugs that a unit test can pin
 * cheaply: callbacks must be the fourth constructor argument, the protocol
 * check must not rely on `connection.type` (the library drops it while
 * merging), and the resolved profile must be merged into the default
 * width/height/audio/video/image settings rather than replacing them.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-guac-proxy');
const RDP_HOST = '10.66.77.88';
const RDP_USER = 'distinctive-user';
const RDP_PASSWORD = 'distinctive-password';

const { captured } = vi.hoisted(() => ({ captured: [] as unknown[][] }));

vi.mock('guacamole-lite', () => ({
	default: class MockGuacamoleLite {
		constructor(...args: unknown[]) {
			captured.push(args);
		}
		on(): void { /* no-op */ }
		close(): void { /* no-op */ }
	}
}));

let sessionId = '';
let callbacks: { processConnectionSettings: (settings: Record<string, unknown>, cb: (err: Error | null, settings?: Record<string, unknown>) => void) => void };
let getRemoteSession: typeof import('../../src/services/remote-sessions.js').getRemoteSession;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'guac-proxy.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const guac = await import('../../src/services/guacamole.js');
	const sessions = await import('../../src/services/remote-sessions.js');
	getRemoteSession = sessions.getRemoteSession;

	dbMod.db.prepare('DELETE FROM remote_sessions').run();
	dbMod.db.prepare('DELETE FROM agents').run();

	dbMod.setSetting('remoteDesktop', {
		enabled: true,
		guacdHost: '127.0.0.1',
		guacdPort: 4822,
		proxyPort: 4823,
		recordingEnabled: false,
		maxSessionMinutes: 60,
		tokenTtlSeconds: 300
	});

	const profile = {
		protocol: 'rdp',
		host: RDP_HOST,
		port: 3389,
		username: RDP_USER,
		password: RDP_PASSWORD,
		ignoreCert: false,
		recording: false
	};
	dbMod.db.prepare(
		"INSERT INTO agents (id, name, hostname, os, arch, token_hash, status, data, last_seen_at) " +
		"VALUES (?, ?, ?, 'linux', 'amd64', ?, 'online', ?, datetime('now'))"
	).run('agent-proxy-1', 'agent-proxy', RDP_HOST, 'fake-token-hash', JSON.stringify({ remoteDesktop: profile }));

	const issued = guac.issueRemoteSession({
		agentId: 'agent-proxy-1',
		userId: 'u1',
		clientIp: '127.0.0.1',
		userAgent: 'vitest'
	});
	const exchanged = guac.exchangeForGuacToken(issued.token);
	expect(exchanged).not.toBeNull();
	sessionId = exchanged!.sessionId;

	guac.startGuacamoleProxy();
	expect(captured).toHaveLength(1);
	const args = captured[0];
	expect(args).toHaveLength(4);
	expect((args[2] as { callbacks?: unknown }).callbacks).toBeUndefined();
	callbacks = args[3] as typeof callbacks;
});

describe('guacamole-lite integration contract', () => {
	it('passes callbacks as the fourth constructor argument', () => {
		expect(typeof callbacks.processConnectionSettings).toBe('function');
	});

	it('merges the profile into the library defaults and claims the session', async () => {
		// guacamole-lite merges these defaults into connection before invoking
		// the callback; the callback must not discard them.
		const tokenSettings = {
			connection: {
				width: 1024,
				height: 768,
				dpi: 96,
				audio: ['audio/L16'],
				video: null,
				image: ['image/png', 'image/jpeg'],
				timezone: null
			},
			itcakeSessionId: sessionId
		};

		const resolved = await new Promise<Record<string, unknown>>((resolve, reject) => {
			callbacks.processConnectionSettings(tokenSettings, (err, settings) => {
				if (err) reject(err);
				else resolve(settings!);
			});
		});

		const connection = resolved.connection as Record<string, unknown>;
		expect(connection.type).toBe('rdp');
		expect(connection.hostname).toBe(RDP_HOST);
		expect(connection.username).toBe(RDP_USER);
		expect(connection.password).toBe(RDP_PASSWORD);
		expect(connection.width).toBe(1024);
		expect(connection.height).toBe(768);
		expect(connection.dpi).toBe(96);
		expect(connection.image).toEqual(['image/png', 'image/jpeg']);
		expect(connection.audio).toEqual(['audio/L16']);

		const session = getRemoteSession(sessionId);
		expect(session?.startedAt).toBeTruthy();
	});

	it('refuses to start the same session twice', async () => {
		await expect(new Promise((resolve, reject) => {
			callbacks.processConnectionSettings({ connection: {}, itcakeSessionId: sessionId }, (err) => {
				if (err) reject(err);
				else resolve(null);
			});
		})).rejects.toThrow(/session already used/);
	});
});
