/**
 * Opt-in live Telegram test.
 *
 * Requires a disposable bot and a chat the operator is willing to receive test
 * messages in:
 *
 *   TELEGRAM_BOT_TOKEN=123456:ABC...
 *   TELEGRAM_CHAT_ID=123456789
 *
 * The test exercises the same `/api/uptime/test-telegram` path the settings UI
 * uses: getMe (token validation) followed by a real sendMessage. It skips when
 * either variable is absent, so normal live runs stay offline-safe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startProductionServer, freshDataDir, cleanupDir, jsonCall, setupAdmin, type LiveServer } from './helpers';

const PORT = 5506;
const DATA_DIR = freshDataDir('telegram');
const ADMIN_EMAIL = 'telegram-live@example.com';

const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? '';
const hasCredentials = botToken.length > 0 && chatId.length > 0;

let server: LiveServer;
let cookie = '';

beforeAll(async () => {
	if (!hasCredentials) return;
	server = await startProductionServer({ port: PORT, dataDir: DATA_DIR });
	cookie = await setupAdmin(server, ADMIN_EMAIL);
}, 120_000);

afterAll(async () => {
	await server?.stop();
	cleanupDir(DATA_DIR);
});

describe.skipIf(!hasCredentials)('live Telegram', () => {
	it('validates the bot token and delivers a real message', async () => {
		const res = await jsonCall(server, 'POST', '/api/uptime/test-telegram', {
			botToken,
			chatId
		}, { cookie });

		expect(res.status, JSON.stringify(res.data)).toBe(200);
		expect(res.data, `Telegram test failed: ${JSON.stringify(res.data)}`).toMatchObject({ success: true });
		expect(String(res.data.botName ?? '').length).toBeGreaterThan(0);
	}, 60_000);

	it('rejects a malformed bot token without calling Telegram', async () => {
		const res = await jsonCall(server, 'POST', '/api/uptime/test-telegram', {
			botToken: 'not-a-token',
			chatId
		}, { cookie });

		expect(res.status).toBe(400);
	}, 30_000);
});
