import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { onAgentEvent } from '$lib/server/agent-events.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const send = (data: string) => {
				try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); }
				catch { /* client disconnected */ }
			};

			// Send initial heartbeat
			send('connected');

			// Subscribe to agent events
			const unsub = onAgentEvent(() => send('update'));

			// Heartbeat every 30s to keep connection alive
			const heartbeat = setInterval(() => send('heartbeat'), 30_000);

			// Cleanup on close
			const cleanup = () => {
				unsub();
				clearInterval(heartbeat);
			};

			// AbortSignal not available on controller, use global cleanup
			controller.close = new Proxy(controller.close, {
				apply(target, thisArg, args) {
					cleanup();
					return Reflect.apply(target, thisArg, args);
				}
			});
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
