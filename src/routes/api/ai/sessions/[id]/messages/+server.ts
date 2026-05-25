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

	const abort = new AbortController();
	request.signal.addEventListener('abort', () => abort.abort(), { once: true });

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			const send = (data: unknown) => {
				try {
					const payload = JSON.stringify(data)
						.replace(/[\u2028\u2029]/g, c => c === '\u2028' ? '\\u2028' : '\\u2029');
					controller.enqueue(enc.encode(`data: ${payload}\n\n`));
				} catch {
					abort.abort();
				}
			};
			try {
				await postMessage({
					sessionId: id,
					userId: locals.user!.id,
					text,
					emitSse: send,
					abortSignal: abort.signal
				});
			} catch (e) {
				const isAbort = (e instanceof Error && (e.name === 'AbortError' || e.message === 'concurrent turn on session'));
				if (isAbort) {
					// controller may already be closed
				} else if (e instanceof AiNotConfiguredError || e instanceof AiBudgetExceededError) {
					send({ type: 'error', error: e.message });
				} else {
					const traceId = crypto.randomUUID();
					console.error(`[ai-message ${traceId}] postMessage failed:`, e);
					send({ type: 'error', error: `AI request failed (trace: ${traceId})` });
				}
			} finally {
				try { controller.close(); } catch { /* already closed by abort */ }
			}
		},
		cancel() {
			abort.abort();
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
