import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getReceiptPath } from '$services/expenses.js';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { safeFilename } from '$lib/server/sanitize.js';

const MIME_TYPES: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.pdf': 'application/pdf'
};

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401);

	const filename = url.searchParams.get('file');
	if (!filename) throw error(400, 'Missing file parameter');

	const filePath = getReceiptPath(filename);
	if (!filePath) throw error(404, 'Receipt not found');

	const ext = extname(filename).toLowerCase();
	const contentType = MIME_TYPES[ext];
	if (!contentType) throw error(400, 'Unsupported file type');
	let data: Buffer;
	try {
		data = readFileSync(filePath);
	} catch {
		throw error(404, 'Receipt file not found on disk');
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
