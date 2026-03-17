import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { onCheckComplete } from '$lib/server/monitor-events.js';

export const GET: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);

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
			cleanup = () => {
				clearInterval(keepalive);
				unsub();
				cleanup = null;
			};
			// Initial keepalive so the client knows the connection is live
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
