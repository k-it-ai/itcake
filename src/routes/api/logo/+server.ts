import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { updateSettingsSection, getSettingsSection } from '$services/settings.js';
import { verifyMagicBytes } from '$lib/server/file-validation.js';
import { UPLOAD_DIR } from '$lib/server/data-dir.js';
const MAX_SIZE = 2 * 1024 * 1024; // 2MB

// SVG excluded — serves as XSS vector when accessed directly
const MIME_TO_EXT: Record<string, string> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/webp': '.webp'
};

/** Upload a logo */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const formData = await request.formData();
	const file = formData.get('logo') as File | null;

	if (!file || file.size === 0) throw error(400, 'No file provided');
	const ext = MIME_TO_EXT[file.type];
	if (!ext) throw error(400, 'Invalid file type. Use PNG, JPEG, or WebP.');
	if (file.size > MAX_SIZE) throw error(400, 'File too large (max 2MB)');

	const filename = `logo${ext}`;

	if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

	const buffer = Buffer.from(await file.arrayBuffer());
	if (!verifyMagicBytes(buffer, file.type)) throw error(400, 'File content does not match declared type');

	// Delete old logo files with different extensions to prevent orphans
	for (const otherExt of Object.values(MIME_TO_EXT)) {
		if (otherExt === ext) continue;
		const oldPath = resolve(join(UPLOAD_DIR, `logo${otherExt}`));
		if (oldPath.startsWith(UPLOAD_DIR + '/') && existsSync(oldPath)) {
			try { unlinkSync(oldPath); } catch { /* ignore */ }
		}
	}

	const writePath = resolve(join(UPLOAD_DIR, filename));
	if (!writePath.startsWith(UPLOAD_DIR + '/')) throw error(400, 'Invalid path');
	writeFileSync(writePath, new Uint8Array(buffer));

	const logoUrl = `/api/logo/${filename}`;
	updateSettingsSection('company', { logoUrl }, locals.user.id);

	return json({ ok: true, logoUrl });
};

/** Serve the uploaded logo */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const company = getSettingsSection('company') as Record<string, unknown> | null;
	const logoUrl = (company?.logoUrl as string) || '';

	const rawFilename = logoUrl.split('/').pop();
	if (!rawFilename) throw error(404, 'No logo uploaded');

	const safeFilename = basename(rawFilename);
	const fileExt = extname(safeFilename).toLowerCase();
	if (!['.png', '.jpg', '.jpeg', '.webp'].includes(fileExt)) throw error(400, 'Invalid file type');
	const filePath = resolve(join(UPLOAD_DIR, safeFilename));
	if (!filePath.startsWith(UPLOAD_DIR + '/')) throw error(400, 'Invalid path');
	if (!existsSync(filePath)) throw error(404, 'Logo file not found');

	const data = readFileSync(filePath);
	const contentType =
		fileExt === '.webp' ? 'image/webp' :
		fileExt === '.jpg' || fileExt === '.jpeg' ? 'image/jpeg' :
		'image/png';

	return new Response(data, {
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'private, max-age=3600'
		}
	});
};
