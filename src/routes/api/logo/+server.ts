import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { existsSync, mkdirSync, constants as fsConstants } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { join, extname, basename, resolve } from 'node:path';
import { updateSettingsSection, getSettingsSection } from '$services/settings.js';
import { verifyMagicBytes } from '$lib/server/file-validation.js';
import { UPLOAD_DIR } from '$lib/server/data-dir.js';
import { notFound, requireUser } from '$lib/server/request-utils.js';
const MAX_SIZE = 2 * 1024 * 1024; // 2MB

// SVG excluded — serves as XSS vector when accessed directly
const MIME_TO_EXT: Record<string, string> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/webp': '.webp'
};

/** Upload a logo */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals, 'Not authenticated');

	// Pre-parse Content-Length check. `request.formData()` buffers the
	// entire body into memory before the post-parse `file.size` check,
	// so without this guard a 2 GiB upload would still get fully buffered
	// before being rejected. Multipart adds ~200B of envelope overhead;
	// MAX_SIZE + 4 KiB is a generous ceiling.
	const cl = parseInt(request.headers.get('content-length') ?? '0', 10);
	if (cl > MAX_SIZE + 4096) throw error(413, 'File too large (max 2MB)');

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

	// Delete old logo files with different extensions to prevent orphans.
	// `unlink` rejects on ENOENT — that's the common case (no old logo), so
	// we swallow and continue.
	await Promise.all(
		Object.values(MIME_TO_EXT)
			.filter(otherExt => otherExt !== ext)
			.map(async otherExt => {
				const oldPath = resolve(join(UPLOAD_DIR, `logo${otherExt}`));
				if (!oldPath.startsWith(UPLOAD_DIR + '/')) return;
				try { await unlink(oldPath); } catch { /* ENOENT or perm denied — ignore */ }
			})
	);

	const writePath = resolve(join(UPLOAD_DIR, filename));
	if (!writePath.startsWith(UPLOAD_DIR + '/')) throw error(400, 'Invalid path');
	// O_NOFOLLOW refuses symlinks; matches the convention used by backup-restore
	// (services/backups.ts) so a pre-existing symlink under UPLOAD_DIR can't
	// redirect the write to an attacker-chosen path.
	const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
	const fh = await open(writePath, flags, 0o600);
	try { await fh.writeFile(new Uint8Array(buffer)); } finally { await fh.close(); }

	const logoUrl = `/api/logo/${filename}`;
	updateSettingsSection('company', { logoUrl }, locals.user.id);

	return json({ ok: true, logoUrl });
};

/** Serve the uploaded logo */
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
	if (!filePath.startsWith(UPLOAD_DIR + '/')) throw error(400, 'Invalid path');

	let data: Buffer;
	try {
		data = await readFile(filePath);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
		throw e;
	}
	const contentType =
		fileExt === '.webp' ? 'image/webp' :
		fileExt === '.jpg' || fileExt === '.jpeg' ? 'image/jpeg' :
		'image/png';

	return new Response(new Uint8Array(data), {
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'private, max-age=3600'
		}
	});
};
