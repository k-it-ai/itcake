import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { statSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { requireUser, notFound } from '$lib/server/request-utils.js';
import { getRemoteSession } from '$services/remote-sessions.js';
import { convertRecording } from '$services/guacamole.js';

/**
 * Stream the MP4 of a remote-desktop session recording. On first access
 * the raw `.guac` wire dump is transcoded and the source unlinked, so
 * subsequent accesses (and the on-disk footprint) hit only the MP4.
 *
 * Authorisation: cookie-session login + the requesting user must own
 * the recorded session. A different operator (in a multi-user future)
 * would 403 here even with the URL.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	if (!/^[a-zA-Z0-9_-]+$/.test(params.sessionId)) throw error(400, 'Invalid session id');

	const session = getRemoteSession(params.sessionId);
	if (!session) throw notFound();
	if (session.userId !== locals.user.id) throw error(403, 'Recording does not belong to you');

	const result = await convertRecording(params.sessionId);
	if (!result.ok || !result.mp4Path) throw error(404, result.error || 'Recording not available');

	const stat = statSync(result.mp4Path);
	const webStream = Readable.toWeb(createReadStream(result.mp4Path)) as ReadableStream;
	return new Response(webStream, {
		headers: {
			'Content-Type': 'video/mp4',
			'Content-Length': String(stat.size),
			'Content-Disposition': `attachment; filename="recording-${params.sessionId}.mp4"`,
			'Cache-Control': 'private, no-store'
		}
	});
};
