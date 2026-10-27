import type { RequestHandler } from './$types.js';
import { onAgentEvent } from '#lib/server/agent-events.js';
import { requireAdmin } from '#lib/server/request-utils.js';

export const GET: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);

	let cleanup: () => void = () => { /* installed in start() */ };
	request.signal.addEventListener('abort', () => cleanup());
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

			let done = false;
			cleanup = () => {
				if (done) return;
				done = true;
				unsub();
				clearInterval(heartbeat);
			};
		},
		cancel() { cleanup(); }
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
