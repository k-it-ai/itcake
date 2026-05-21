import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto, { randomBytes } from 'node:crypto';

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
		host: RDP_HOST,
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

// The token format is now a two-layer wrap: outer { mac, inner } verifies
// integrity (HMAC-SHA256 over inner) and inner is the legacy CBC blob
// `{ iv, value }` that guacamole-lite knows how to decrypt. The verifier
// in startGuacamoleProxy's verifyClient checks the HMAC and substitutes
// inner into the WS URL before guacamole-lite parses the token.
function unwrapToInner(guacToken: string, secret: string): string {
	const outer = JSON.parse(Buffer.from(guacToken, 'base64').toString('utf8')) as { mac: string; inner: string };
	const hmacKey = crypto.scryptSync(secret, 'itcake-guac-token-hmac:1', 32);
	const expected = crypto.createHmac('sha256', hmacKey).update(outer.inner).digest();
	const got = Buffer.from(outer.mac, 'hex');
	if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
		throw new Error('outer HMAC mismatch');
	}
	return outer.inner;
}

function decryptGuacToken(guacToken: string, secret: string): string {
	const inner = unwrapToInner(guacToken, secret);
	const wrapped = JSON.parse(Buffer.from(inner, 'base64').toString('utf8')) as { iv: string; value: string };
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

		expect(payload.itcakeSessionId).toBe(exchanged!.sessionId);
		expect((payload.connection as Record<string, unknown>).type).toBe('rdp');
		expect((payload.connection as Record<string, unknown>).settings).toEqual({});

		expect(plaintext).not.toContain(RDP_PASSWORD);
		expect(plaintext).not.toContain(RDP_USER);
		expect(plaintext).not.toContain(RDP_HOST);
		expect(plaintext).not.toContain('recording-path');
		expect(plaintext).not.toContain('private-key');
		expect(plaintext).not.toContain('hostname');
		expect(plaintext).not.toContain('password');
	});

	it('our token decrypts under guacamole-lite Crypt with a Buffer key', async () => {
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore — guacamole-lite ships JS without bundled types
		const Crypt = (await import('guacamole-lite/lib/Crypt.js')).default ?? (await import('guacamole-lite/lib/Crypt.js'));
		const key = crypto.scryptSync(process.env.SESSION_SECRET!, 'itcake-guacamole-token-v1', 32);
		const issued = issueRemoteSession({
			agentId: 'agent-rd-1', userId: 'u1', clientIp: '127.0.0.1', userAgent: 'vitest'
		});
		const exchanged = exchangeForGuacToken(issued.token);
		expect(exchanged).not.toBeNull();
		const c = new Crypt('AES-256-CBC', key);
		// guacamole-lite only sees the inner blob after verifyClient strips
		// the HMAC wrap. Reproduce that here so the lib-decrypt invariant
		// stays pinned.
		const inner = unwrapToInner(exchanged!.guacToken, process.env.SESSION_SECRET!);
		const decoded = c.decrypt(inner);
		expect(decoded.itcakeSessionId).toBe(exchanged!.sessionId);
	});

	it('rejects a tampered outer HMAC (defense against CBC malleability)', () => {
		const issued = issueRemoteSession({
			agentId: 'agent-rd-1', userId: 'u1', clientIp: '127.0.0.1', userAgent: 'vitest'
		});
		const exchanged = exchangeForGuacToken(issued.token);
		expect(exchanged).not.toBeNull();
		// Flip a bit in the inner CBC ciphertext. The outer HMAC binds
		// to the original inner, so a single-bit flip must be caught.
		const outer = JSON.parse(Buffer.from(exchanged!.guacToken, 'base64').toString('utf8')) as { mac: string; inner: string };
		const innerBuf = Buffer.from(outer.inner, 'utf8');
		innerBuf[0] = innerBuf[0] ^ 0x01;
		const tampered = Buffer.from(JSON.stringify({ mac: outer.mac, inner: innerBuf.toString('utf8') }), 'utf8').toString('base64');
		expect(() => decryptGuacToken(tampered, process.env.SESSION_SECRET!)).toThrow(/outer HMAC mismatch/);
	});
});
