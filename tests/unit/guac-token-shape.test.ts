import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto, { randomBytes } from 'node:crypto';

// Disposable-DB test that proves the encrypted Guacamole token carries
// only `connection.type` + `itcakeSessionId` — no hostname, port,
// username, password, recording-path, or any other connection-sensitive
// field. A regression here would re-introduce the AES-CBC malleability
// risk the previous design relied on guacamole-lite to mitigate.
const TEST_DIR = path.resolve('data-test-guac-token');
const RDP_PASSWORD = 'super-secret-rdp-pa$$w0rd-do-not-leak';
const RDP_USER = 'distinctive-username-must-not-leak';
const RDP_HOST = '10.66.77.88';

let db: typeof import('../../src/lib/server/db.js').db;
let issueRemoteSession: typeof import('../../src/services/guacamole.js').issueRemoteSession;
let exchangeForGuacToken: typeof import('../../src/services/guacamole.js').exchangeForGuacToken;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;
let encryptField: typeof import('../../src/lib/server/field-crypto.js').encryptField;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'guac.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const guac = await import('../../src/services/guacamole.js');
	const fc = await import('../../src/lib/server/field-crypto.js');
	db = dbMod.db;
	setSetting = dbMod.setSetting;
	issueRemoteSession = guac.issueRemoteSession;
	exchangeForGuacToken = guac.exchangeForGuacToken;
	encryptField = fc.encryptField;

	// Wipe any prior state and stand up the minimum schema we need.
	db.prepare('DELETE FROM remote_sessions').run();
	db.prepare('DELETE FROM agents').run();

	setSetting('remoteDesktop', {
		enabled: true,
		guacdHost: '127.0.0.1',
		guacdPort: 4822,
		proxyPort: 4823,
		recordingEnabled: false,
		maxSessionMinutes: 60,
		tokenTtlSeconds: 300
	});

	const agentId = 'agent-rd-1';
	const profile = {
		protocol: 'rdp',
		port: 3389,
		username: RDP_USER,
		password: encryptField(RDP_PASSWORD),
		ignoreCert: false,
		recording: false
	};
	db.prepare(
		"INSERT INTO agents (id, name, hostname, os, arch, token_hash, status, data, last_seen_at) " +
		"VALUES (?, ?, ?, 'linux', 'x86_64', ?, 'online', ?, datetime('now'))"
	).run(agentId, 'agent-rd', RDP_HOST, 'fake-token-hash', JSON.stringify({ ip: RDP_HOST, remoteDesktop: profile }));
});

/**
 * Reverses the wrapper guacamole-lite expects:
 *   base64( JSON({ iv: base64(iv), value: base64(ciphertext) }) )
 * Returns the decrypted JSON string.
 */
function decryptGuacToken(guacToken: string, secret: string): string {
	const wrapped = JSON.parse(Buffer.from(guacToken, 'base64').toString('utf8')) as { iv: string; value: string };
	const key = crypto.scryptSync(secret, 'itcake-guacamole-token-v1', 32);
	const iv = Buffer.from(wrapped.iv, 'base64');
	const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
	const ciphertext = Buffer.from(wrapped.value, 'base64');
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return plaintext.toString('utf8');
}

describe('Guacamole token shape (no creds in encrypted blob)', () => {
	it('mints a token containing only connection.type + itcakeSessionId', () => {
		const issued = issueRemoteSession({
			agentId: 'agent-rd-1',
			userId: 'u1',
			clientIp: '127.0.0.1',
			userAgent: 'vitest'
		});
		const exchanged = exchangeForGuacToken(issued.token);
		expect(exchanged).not.toBeNull();
		const guacToken = exchanged!.guacToken;

		const plaintext = decryptGuacToken(guacToken, process.env.SESSION_SECRET!);
		const payload = JSON.parse(plaintext) as Record<string, unknown>;

		// Required fields
		expect(payload.itcakeSessionId).toBe(exchanged!.sessionId);
		expect((payload.connection as Record<string, unknown>).type).toBe('rdp');
		expect((payload.connection as Record<string, unknown>).settings).toEqual({});

		// Negative assertions — these used to be present in the token under the
		// old design and would re-appear if someone reverted the refactor.
		expect(plaintext).not.toContain(RDP_PASSWORD);
		expect(plaintext).not.toContain(RDP_USER);
		expect(plaintext).not.toContain(RDP_HOST);
		expect(plaintext).not.toContain('recording-path');
		expect(plaintext).not.toContain('private-key');
		expect(plaintext).not.toContain('hostname');
		expect(plaintext).not.toContain('password');
	});
});
