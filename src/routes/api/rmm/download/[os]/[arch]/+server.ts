import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { lstatSync, constants as fsConstants, openSync, closeSync } from 'node:fs';
import { Readable } from 'node:stream';
import { getOrBuildAgentBinary, diagnoseDownloadFailure, readAgentBinaryWithHash } from '#lib/server/agent-build.js';
import { authenticateAgent } from '#lib/server/agent-auth.js';
import { recordChange } from '#lib/server/changes.js';

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
	const extension = os === 'windows' ? '.exe' : '';
	const filename = `itcake-agent-${os}-${arch}${extension}`;
	// O_NOFOLLOW + read + hash from the same fd so body and header hash always agree.
	const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	let payload: { bytes: Buffer; hash: string } | null = null;
	try {
		payload = readAgentBinaryWithHash(os, arch, fd);
	} finally {
		// readFileSync(fd) does not auto-close in Node — closeSync is required.
		try { closeSync(fd); } catch (e) {
			if ((e as NodeJS.ErrnoException)?.code !== 'EBADF') throw e;
		}
	}
	if (!payload) {
		return json({ error: 'Failed to read agent binary' }, { status: 500 });
	}
	const { bytes, hash } = payload;

	// recordChange fires on stream end so audit rows reflect only fully-served downloads.
	const actor = locals.user?.id ?? 'system';
	const entityId = agent?.id ?? `download:${os}-${arch}`;
	let audited = false;
	const recordDownload = () => {
		if (audited) return;
		audited = true;
		try {
			recordChange('agent', entityId, 'update', {
				binaryDownload: {
					old: null,
					new: { os, arch, sha256: hash, requesterAgentId: agent?.id ?? null }
				}
			}, actor);
		} catch (e) {
			console.warn('[rmm-download] audit recordChange failed:', e instanceof Error ? e.message : e);
		}
	};
	const stream = Readable.from(bytes);
	stream.on('end', recordDownload);
	const webStream = Readable.toWeb(stream) as ReadableStream;

	const b64 = Buffer.from(hash, 'hex').toString('base64');
	const headers: Record<string, string> = {
		'Content-Type': 'application/octet-stream',
		'Content-Disposition': `attachment; filename="${filename}"`,
		'Content-Length': String(bytes.length),
		'Cache-Control': 'no-cache',
		'X-Binary-SHA256': hash,
		'Content-Digest': `sha-256=:${b64}:`
	};

	return new Response(webStream, { headers });
};
