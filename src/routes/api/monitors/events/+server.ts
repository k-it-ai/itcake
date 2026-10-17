import type { RequestHandler } from './$types.js';
import { onCheckComplete } from '#lib/server/monitor-events.js';
import { requireUser } from '#lib/server/request-utils.js';

export const GET: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	let cleanup: (() => void) | null = null;
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			const send = () => {
				try { controller.enqueue(encoder.encode(`data: update\n\n`)); }
				catch { cleanup?.(); }
			};
			const unsub = onCheckComplete(send);
			const keepalive = setInterval(() => {
				try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); }
				catch { cleanup?.(); }
			}, 30_000);
			if (typeof keepalive === 'object' && keepalive && 'unref' in keepalive) {
				(keepalive as NodeJS.Timeout).unref();
			}
			cleanup = () => {
				clearInterval(keepalive);
				unsub();
				cleanup = null;
			};
			controller.enqueue(encoder.encode(`: connected\n\n`));
		},
		cancel() { cleanup?.(); }
	});

	request.signal.addEventListener('abort', () => cleanup?.());

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		}
	});
};
