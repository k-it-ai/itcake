import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { statSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { getOrBuildAgentBinary, diagnoseDownloadFailure, getAgentBinaryHash } from '$lib/server/agent-build.js';
import { authenticateAgent } from '$lib/server/agent-auth.js';
import { recordChange } from '$lib/server/changes.js';

const VALID_OS = new Set(['darwin', 'linux', 'windows']);
const VALID_ARCH = new Set(['amd64', 'arm64']);

export const GET: RequestHandler = async ({ params, locals, request }) => {
	const agent = !locals.user ? authenticateAgent(request) : null;
	if (!locals.user && !agent) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}
	const { os, arch } = params;

	if (!VALID_OS.has(os)) return json({ error: 'Invalid OS. Must be darwin, linux, or windows' }, { status: 400 });
	if (!VALID_ARCH.has(arch)) return json({ error: 'Invalid architecture. Must be amd64 or arm64' }, { status: 400 });

	const filePath = await getOrBuildAgentBinary(os, arch);
	if (!filePath) {
		const reason = await diagnoseDownloadFailure(os, arch);
		return json({ error: reason }, { status: 404 });
	}

	const stat = statSync(filePath);
	const extension = os === 'windows' ? '.exe' : '';
	const filename = `itcake-agent-${os}-${arch}${extension}`;
	const stream = createReadStream(filePath);
	const webStream = Readable.toWeb(stream) as ReadableStream;

	// check-in. Also populates RFC 9530's Content-Digest where tooling can
	const hash = getAgentBinaryHash(os, arch);
	const headers: Record<string, string> = {
		'Content-Type': 'application/octet-stream',
		'Content-Disposition': `attachment; filename="${filename}"`,
		'Content-Length': String(stat.size),
		'Cache-Control': 'no-cache'
	};
	if (hash) {
		headers['X-Binary-SHA256'] = hash;
		// RFC 9530: Content-Digest: sha-256=:<base64>:
		const b64 = Buffer.from(hash, 'hex').toString('base64');
		headers['Content-Digest'] = `sha-256=:${b64}:`;
	}

	// Audit binary downloads. Agent-initiated downloads (bearer-authenticated)
	// are useful to track because a `CompromisedBearer` could fetch binaries
	// for arches they don't run on — silent today, visible in `/api/changes`
	// after this. Operator-initiated downloads (cookie-authenticated) are
	// audited under the operator's userId; agent-initiated are recorded
	// under `'system'` (the backup-restore validator only accepts user ids
	// that exist in the `users` table or the literal `'system'`).
	try {
		const actor = locals.user?.id ?? 'system';
		const entityId = agent?.id ?? `download:${os}-${arch}`;
		recordChange('agent', entityId, 'update', {
			binaryDownload: {
				old: null,
				new: { os, arch, sha256: hash ?? null, requesterAgentId: agent?.id ?? null }
			}
		}, actor);
	} catch (e) {
		console.warn('[rmm-download] audit recordChange failed:', e instanceof Error ? e.message : e);
	}

	return new Response(webStream, { headers });
};
