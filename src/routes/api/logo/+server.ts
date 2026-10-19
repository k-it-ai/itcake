import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { existsSync, mkdirSync, chmodSync, constants as fsConstants } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { join, extname, basename, resolve, sep } from 'node:path';
import { updateSettingsSection, getSettingsSection } from '#services/settings.js';
import { verifyMagicBytes } from '#lib/server/file-validation.js';
import { UPLOAD_DIR } from '#lib/server/data-dir.js';
import { notFound, requireUser } from '#lib/server/request-utils.js';
const MAX_SIZE = 2 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/webp': '.webp'
};

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals, 'Not authenticated');

	const cl = parseInt(request.headers.get('content-length') ?? '0', 10);
	if (cl > MAX_SIZE + 4096) throw error(413, 'File too large (max 2MB)');

	const formData = await request.formData();
	const file = formData.get('logo') as File | null;

	if (!file || file.size === 0) throw error(400, 'No file provided');
	const ext = MIME_TO_EXT[file.type];
	if (!ext) throw error(400, 'Invalid file type. Use PNG, JPEG, or WebP.');
	if (file.size > MAX_SIZE) throw error(400, 'File too large (max 2MB)');

	const filename = `logo${ext}`;

	if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
	try { chmodSync(UPLOAD_DIR, 0o700); } catch { /* best effort */ }

	const buffer = Buffer.from(await file.arrayBuffer());
	if (!verifyMagicBytes(buffer, file.type)) throw error(400, 'File content does not match declared type');

	await Promise.all(
		Object.values(MIME_TO_EXT)
			.filter(otherExt => otherExt !== ext)
			.map(async otherExt => {
				const oldPath = resolve(join(UPLOAD_DIR, `logo${otherExt}`));
				if (!oldPath.startsWith(UPLOAD_DIR + sep)) return;
				try { await unlink(oldPath); } catch { /* ENOENT or perm denied — ignore */ }
			})
	);

	const writePath = resolve(join(UPLOAD_DIR, filename));
	if (!writePath.startsWith(UPLOAD_DIR + sep)) throw error(400, 'Invalid path');
	const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
	const fh = await open(writePath, flags, 0o600);
	try { await fh.writeFile(new Uint8Array(buffer)); } finally { await fh.close(); }

	const logoUrl = `/api/logo/${filename}`;
	updateSettingsSection('company', { logoUrl }, locals.user.id);

	return json({ ok: true, logoUrl });
};

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals, 'Not authenticated');

	const company = getSettingsSection('company') as Record<string, unknown> | null;
	const logoUrl = (company?.logoUrl as string) || '';

	const rawFilename = logoUrl.split('/').pop();
	if (!rawFilename) throw notFound();

	const safeFilename = basename(rawFilename);
	const fileExt = extname(safeFilename).toLowerCase();
	if (!['.png', '.jpg', '.jpeg', '.webp'].includes(fileExt)) throw error(400, 'Invalid file type');
	const filePath = resolve(join(UPLOAD_DIR, safeFilename));
	if (!filePath.startsWith(UPLOAD_DIR + sep)) throw error(400, 'Invalid path');

	let data: Buffer;
	try {
		const fh = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			data = await fh.readFile();
		} finally {
			await fh.close();
		}
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ELOOP') throw notFound();
		throw e;
	}
	const contentType =
		fileExt === '.webp' ? 'image/webp' :
		fileExt === '.jpg' || fileExt === '.jpeg' ? 'image/jpeg' :
		'image/png';

	return new Response(new Uint8Array(data), {
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'no-store',
			'Content-Disposition': `attachment; filename="${safeFilename}"`
		}
	});
};
