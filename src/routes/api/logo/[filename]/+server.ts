import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { UPLOAD_DIR } from '$lib/server/data-dir.js';

/** Serve uploaded logo by filename */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const safeFilename = basename(params.filename);
	if (!safeFilename) throw error(400, 'Invalid filename');

	const ext = extname(safeFilename).toLowerCase();
	if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw error(400, 'Invalid file type');

	const filePath = resolve(join(UPLOAD_DIR, safeFilename));
	if (!filePath.startsWith(UPLOAD_DIR + '/')) throw error(400, 'Invalid path');
	if (!existsSync(filePath)) throw error(404, 'File not found');

	let data: Buffer;
	try {
		data = readFileSync(filePath);
	} catch {
		throw error(404, 'File not found');
	}
	const contentType =
		ext === '.webp' ? 'image/webp' :
		ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
		'image/png';

	return new Response(new Uint8Array(data), {
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'private, max-age=3600'
		}
	});
};
