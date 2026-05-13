import crypto from 'node:crypto';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser } from '$lib/server/request-utils.js';
import { getSession, postMessage, AiNotConfiguredError, AiBudgetExceededError } from '$services/ai-session.js';

export const POST: RequestHandler = async ({ request, params, locals }) => {
	requireUser(locals);
	const id = String(params.id);
	const s = getSession(id);
	if (!s || s.userId !== locals.user!.id) throw error(404, 'session not found');

	const body = await parseJsonBody<{ text?: string }>(request);
	const text = typeof body.text === 'string' ? body.text : '';
	if (!text.trim()) throw error(400, 'text is required');

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			const send = (data: unknown) => {
				// JSON.stringify escapes \n and \r but passes U+2028 / U+2029
				// (JS-only line terminators) through unescaped. Browser
				// EventSource ignores those, but third-party SSE clients that
				// line-split on any Unicode line terminator would mis-frame.
				// Re-escape both before encoding.
				const payload = JSON.stringify(data)
					.replace(/[\u2028\u2029]/g, c => c === '\u2028' ? '\\u2028' : '\\u2029');
				controller.enqueue(enc.encode(`data: ${payload}\n\n`));
			};
			try {
				await postMessage({
					sessionId: id,
					userId: locals.user!.id,
					text,
					emitSse: send
				});
			} catch (e) {
				// Known operator-facing errors carry safe, translatable messages.
				if (e instanceof AiNotConfiguredError || e instanceof AiBudgetExceededError) {
					send({ type: 'error', error: e.message });
				} else {
					// Unknown errors may include Anthropic SDK internals, file
					// paths, or stack-derived strings. Log server-side with a
					// trace id; surface only a generic message + id to the UI
					// so paths / library internals don't leak through the SSE
					// channel (matches hooks.server.ts:151-158 for HTTP errors).
					const traceId = crypto.randomUUID();
					console.error(`[ai-message ${traceId}] postMessage failed:`, e);
					send({ type: 'error', error: `AI request failed (trace: ${traceId})` });
				}
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-store, no-transform',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
