import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { openSync, readSync, closeSync, fstatSync, existsSync, constants as fsConstants } from 'node:fs';
import { join, extname, basename, resolve, sep } from 'node:path';
import { UPLOAD_DIR } from '$lib/server/data-dir.js';
import { notFound, requireUser } from '$lib/server/request-utils.js';

const MAX_LOGO_BYTES = 10 * 1024 * 1024;

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals, 'Not authenticated');

	const safeFilename = basename(params.filename);
	if (!safeFilename) throw error(400, 'Invalid filename');

	const ext = extname(safeFilename).toLowerCase();
	if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw error(400, 'Invalid file type');

	const filePath = resolve(join(UPLOAD_DIR, safeFilename));
	if (!filePath.startsWith(UPLOAD_DIR + sep)) throw error(400, 'Invalid path');
	if (!existsSync(filePath)) throw notFound();

	let fd: number;
	try {
		fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch {
		throw notFound();
	}
	let data: Buffer;
	try {
		const stat = fstatSync(fd);
		if (stat.size > MAX_LOGO_BYTES) throw error(400, 'Logo file too large');
		data = Buffer.alloc(stat.size);
		let total = 0;
		while (total < stat.size) {
			const n = readSync(fd, data, total, stat.size - total, total);
			if (n <= 0) break;
			total += n;
		}
	} finally {
		try { closeSync(fd); } catch { /* best effort */ }
	}
	const contentType =
		ext === '.webp' ? 'image/webp' :
		ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
		'image/png';

	return new Response(new Uint8Array(data), {
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'no-store',
			'Content-Disposition': `attachment; filename="${safeFilename}"`
		}
	});
};
