/**
 * Opt-in live Anthropic test.
 *
 * Requires an API key with access to the configured model:
 *
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   ANTHROPIC_LIVE_MODEL=claude-haiku-4-5   # optional
 *
 * The test saves real AI settings, starts a session, and posts one short
 * message through the streaming endpoint. It asserts that the stream contains
 * generated text and no error event — i.e. a real request reached Anthropic
 * and came back through the production SSE path. It skips without a key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { startProductionServer, freshDataDir, cleanupDir, jsonCall, setupAdmin, type LiveServer } from './helpers';

const PORT = 5507;
const DATA_DIR = freshDataDir('anthropic');
const ADMIN_EMAIL = 'anthropic-live@example.com';

const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
const model = (process.env.ANTHROPIC_LIVE_MODEL?.trim() || 'claude-haiku-4-5') as
	| 'claude-opus-4-7'
	| 'claude-opus-4-6'
	| 'claude-sonnet-4-6'
	| 'claude-haiku-4-5';
const hasKey = apiKey.length > 0;

let server: LiveServer;
let cookie = '';

interface SseEvent {
	type?: string;
	delta?: string;
	error?: string;
	[key: string]: unknown;
}

function parseSse(body: string): SseEvent[] {
	return body
		.split('\n\n')
		.map((frame) => frame.trim())
		.filter(Boolean)
		.flatMap((frame) =>
			frame
				.split('\n')
				.filter((line) => line.startsWith('data: '))
				.map((line) => {
					try {
						return JSON.parse(line.slice(6)) as SseEvent;
					} catch {
						return { type: 'parse_error', raw: line } as SseEvent;
					}
				})
		);
}

beforeAll(async () => {
	if (!hasKey) return;
	server = await startProductionServer({ port: PORT, dataDir: DATA_DIR });
	cookie = await setupAdmin(server, ADMIN_EMAIL);

	const saved = await jsonCall(server, 'POST', '/api/settings', {
		section: 'ai',
		data: {
			enabled: true,
			apiKey,
			model,
			// Keep the live test cheap: $1 cap and the smallest allowed output.
			monthlyBudgetCents: 100,
			approvalMode: 'auto_approve_safe',
			maxTurnsPerSession: 2,
			maxOutputTokensPerTurn: 256,
			thinkingMode: 'disabled',
			consultantMode: true
		}
	}, { cookie });
	expect(saved.status, JSON.stringify(saved.data)).toBe(200);
}, 120_000);

afterAll(async () => {
	await server?.stop();
	cleanupDir(DATA_DIR);
});

describe.skipIf(!hasKey)('live Anthropic', () => {
	it('streams a real model response through the AI session endpoint', async () => {
		const session = await jsonCall(server, 'POST', '/api/ai/sessions', {
			title: 'Live Anthropic test'
		}, { cookie });
		expect(session.status, JSON.stringify(session.data)).toBe(200);
		const sessionId = String(session.data.id ?? '');
		expect(sessionId).toBeTruthy();

		const token = `ITCAKE_LIVE_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
		const res = await fetch(`${server.base}/api/ai/sessions/${encodeURIComponent(sessionId)}/messages`, {
			method: 'POST',
			headers: {
				Cookie: cookie,
				Origin: server.origin,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				text: `Repeat this token exactly and nothing else: ${token}`
			})
		});

		expect(res.status, `AI endpoint returned ${res.status}`).toBe(200);
		const events = parseSse(await res.text());
		const errors = events.filter((event) => event.type === 'error');
		expect(errors, `AI stream returned errors: ${JSON.stringify(errors)}`).toHaveLength(0);

		const text = events
			.filter((event) => event.type === 'text_delta')
			.map((event) => String(event.delta ?? ''))
			.join('');
		expect(text.length, 'AI stream contained no text deltas').toBeGreaterThan(0);
		expect(text.toUpperCase()).toContain(token);

		// The turn must be persisted for the session history.
		const history = await jsonCall(
			server,
			'GET',
			`/api/ai/sessions/${encodeURIComponent(sessionId)}`,
			undefined,
			{ cookie }
		);
		expect(history.status, JSON.stringify(history.data)).toBe(200);
	}, 180_000);
});
