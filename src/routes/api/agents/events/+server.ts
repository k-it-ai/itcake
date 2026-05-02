import type { RequestHandler } from './$types.js';
import { onAgentEvent } from '$lib/server/agent-events.js';
import { requireUser } from '$lib/server/request-utils.js';

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const send = (data: string) => {
				try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); }
				catch { /* client disconnected */ }
			};

			send('connected');

			const unsub = onAgentEvent(() => send('update'));

			const heartbeat = setInterval(() => send('heartbeat'), 30_000);
			heartbeat.unref?.();

			const cleanup = () => {
				unsub();
				clearInterval(heartbeat);
			};

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
