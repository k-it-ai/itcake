import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { statSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { getOrBuildAgentBinary, diagnoseDownloadFailure } from '$lib/server/agent-build.js';
import { authenticateAgent } from '$lib/server/agent-auth.js';

const VALID_OS = new Set(['darwin', 'linux']);
const VALID_ARCH = new Set(['amd64', 'arm64']);

export const GET: RequestHandler = async ({ params, locals, request }) => {
	// Accept either cookie session (UI download) or bearer token (agent self-update)
	if (!locals.user && !authenticateAgent(request)) throw error(401, 'Not authenticated');
	const { os, arch } = params;

	if (!VALID_OS.has(os)) throw error(400, 'Invalid OS. Must be darwin or linux');
	if (!VALID_ARCH.has(arch)) throw error(400, 'Invalid architecture. Must be amd64 or arm64');

	// Try to get existing binary or build on demand
	const filePath = await getOrBuildAgentBinary(os, arch);
	if (!filePath) {
		const reason = await diagnoseDownloadFailure(os, arch);
		throw error(404, reason);
	}

	const stat = statSync(filePath);
	const filename = `itcake-agent-${os}-${arch}`;
	const stream = createReadStream(filePath);
	const webStream = Readable.toWeb(stream) as ReadableStream;

	return new Response(webStream, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Content-Length': String(stat.size),
			'Cache-Control': 'no-cache'
		}
	});
};
