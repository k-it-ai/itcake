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
				controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
			};
			try {
				await postMessage({
					sessionId: id,
					userId: locals.user!.id,
					text,
					emitSse: send
				});
			} catch (e) {
				if (e instanceof AiNotConfiguredError || e instanceof AiBudgetExceededError) {
					send({ type: 'error', error: e.message });
				} else {
					send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
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
