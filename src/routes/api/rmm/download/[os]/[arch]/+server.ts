import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { lstatSync, statSync, createReadStream, constants as fsConstants, openSync } from 'node:fs';
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

	// Bearer-authenticated agents may only fetch their own OS/arch — otherwise
	// a compromised Linux bearer could enumerate the Windows binary for
	// supply-chain pivot. Operator (cookie-auth) downloads stay unrestricted.
	if (agent && (agent.os !== os || agent.arch !== arch)) {
		return json({ error: 'Agent may only download its own OS/arch binary' }, { status: 403 });
	}

	const filePath = await getOrBuildAgentBinary(os, arch);
	if (!filePath) {
		const reason = await diagnoseDownloadFailure(os, arch);
		return json({ error: reason }, { status: 404 });
	}

	const lstat = lstatSync(filePath);
	if (lstat.isSymbolicLink()) {
		return json({ error: 'Binary path is a symlink — refusing' }, { status: 500 });
	}
	const stat = statSync(filePath);
	const extension = os === 'windows' ? '.exe' : '';
	const filename = `itcake-agent-${os}-${arch}${extension}`;
	const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	const stream = createReadStream(filePath, { fd });

	// Audit recordChange runs ON STREAM END so the audit log is a strict
	// subset of actually-served downloads. Previously it ran before the
	// stream started, producing a "binary downloaded" row for connections
	// that the client RST-reset mid-transfer. Connection drops would
	// otherwise look identical in /api/changes to successful pulls.
	const actor = locals.user?.id ?? 'system';
	const hash = getAgentBinaryHash(os, arch);
	const entityId = agent?.id ?? `download:${os}-${arch}`;
	let audited = false;
	const recordDownload = () => {
		if (audited) return;
		audited = true;
		try {
			recordChange('agent', entityId, 'update', {
				binaryDownload: {
					old: null,
					new: { os, arch, sha256: hash ?? null, requesterAgentId: agent?.id ?? null }
				}
			}, actor);
		} catch (e) {
			console.warn('[rmm-download] audit recordChange failed:', e instanceof Error ? e.message : e);
		}
	};
	stream.on('end', recordDownload);
	// 'close' fires on premature client disconnect too — only audit when
	// 'end' (full content sent) fired first.
	const webStream = Readable.toWeb(stream) as ReadableStream;

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

	return new Response(webStream, { headers });
};
