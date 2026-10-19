import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getReceiptPath } from '#services/expenses.js';
import { openSync, fstatSync, readSync, closeSync, constants as fsConstants } from 'node:fs';
import { extname } from 'node:path';
import { safeFilename } from '#lib/server/sanitize.js';
import { notFound, requireUser } from '#lib/server/request-utils.js';

const MIME_TYPES: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.pdf': 'application/pdf'
};

export const GET: RequestHandler = async ({ url, locals }) => {
	requireUser(locals);

	const filename = url.searchParams.get('file');
	if (!filename) throw error(400, 'Missing file parameter');

	const filePath = getReceiptPath(filename);
	if (!filePath) throw notFound();

	const ext = extname(filename).toLowerCase();
	const contentType = MIME_TYPES[ext];
	if (!contentType) throw error(400, 'Unsupported file type');
	let data: Buffer;
	let fd: number;
	try {
		fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch {
		throw notFound();
	}
	try {
		const stat = fstatSync(fd);
		const MAX_RECEIPT_BYTES = 20 * 1024 * 1024;
		if (stat.size > MAX_RECEIPT_BYTES) throw error(400, 'Receipt file too large');
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
	const safeName = safeFilename(filename);

	return new Response(new Uint8Array(data), {
		headers: {
			'Content-Type': contentType,
			'Content-Disposition': `${contentType === 'application/pdf' ? 'attachment' : 'inline'}; filename="${safeName}"`,
			'Cache-Control': 'private, no-store'
		}
	});
};
