import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { openSync, readSync, closeSync, fstatSync, existsSync, constants as fsConstants } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { UPLOAD_DIR } from '$lib/server/data-dir.js';
import { notFound, requireUser } from '$lib/server/request-utils.js';

// 10 MiB ceiling — logos are tiny PNG/JPEG; anything larger is a symptom
// of file-system tampering or a misconfigured upload path.
const MAX_LOGO_BYTES = 10 * 1024 * 1024;

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals, 'Not authenticated');

	const safeFilename = basename(params.filename);
	if (!safeFilename) throw error(400, 'Invalid filename');

	const ext = extname(safeFilename).toLowerCase();
	if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw error(400, 'Invalid file type');

	const filePath = resolve(join(UPLOAD_DIR, safeFilename));
	if (!filePath.startsWith(UPLOAD_DIR + '/')) throw error(400, 'Invalid path');
	if (!existsSync(filePath)) throw notFound();

	// O_NOFOLLOW symlink defense: the write path opens with `O_NOFOLLOW`
	// (POST /api/logo), but the read path used plain `readFileSync` which
	// silently followed symlinks. A LocalNonRoot attacker who could write
	// into UPLOAD_DIR could plant a symlink to /etc/passwd and serve it
	// to any authenticated operator. UPLOAD_DIR is service-owned 0700 so
	// the practical bar is high; this closes the residual.
	let fd: number;
	try {
		fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch {
		// ELOOP (symlink encountered with O_NOFOLLOW) and ENOENT/EACCES all
		// land here; surface as 404 either way.
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
