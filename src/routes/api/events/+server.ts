import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { events } from '$lib/server/events.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);

	let unsubscribe: (() => void) | null = null;
	let interval: ReturnType<typeof setInterval> | null = null;
	let cancelled = false;

	function cleanup() {
		cancelled = true;
		if (interval) { clearInterval(interval); interval = null; }
		if (unsubscribe) { unsubscribe(); unsubscribe = null; }
	}

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			controller.enqueue(encoder.encode(': keepalive\n\n'));

			unsubscribe = events.subscribe((event, data) => {
				const safeEvent = event.replace(/[\r\n]/g, '');
				const msg = `event: ${safeEvent}\ndata: ${JSON.stringify(data)}\n\n`;
				try {
					controller.enqueue(encoder.encode(msg));
				} catch {
					cleanup();
				}
			});

			interval = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'));
				} catch {
					cleanup();
				}
			}, 30000);
			if (typeof interval === 'object' && interval && 'unref' in interval) {
				(interval as NodeJS.Timeout).unref();
			}

			// If cancel() fired before start() assigned resources, clean up now
			if (cancelled) cleanup();
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
