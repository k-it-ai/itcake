import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { events } from '$lib/server/events.js';
import { isSessionTokenValid } from '$lib/server/auth.js';
import { requireUser } from '$lib/server/request-utils.js';

export const GET: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	const cookieHeader = request.headers.get('cookie') ?? '';
	const sessionToken = cookieHeader.match(/itcake_session=([0-9a-f]{64})/)?.[1] ?? '';

	let unsubscribe: (() => void) | null = null;
	let interval: ReturnType<typeof setInterval> | null = null;
	let authInterval: ReturnType<typeof setInterval> | null = null;
	let cancelled = false;

	function cleanup() {
		cancelled = true;
		if (interval) { clearInterval(interval); interval = null; }
		if (authInterval) { clearInterval(authInterval); authInterval = null; }
		if (unsubscribe) { unsubscribe(); unsubscribe = null; }
	}

	request.signal.addEventListener('abort', () => cleanup());

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

			authInterval = setInterval(() => {
				if (!sessionToken || !isSessionTokenValid(sessionToken)) {
					try { controller.close(); } catch { /* already closed */ }
					cleanup();
				}
			}, 60_000);
			if (typeof authInterval === 'object' && authInterval && 'unref' in authInterval) {
				(authInterval as NodeJS.Timeout).unref();
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
