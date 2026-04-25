import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { createBackup, getBackups, getBackupPath, deleteBackup, restoreBackup, previewRestore } from '$services/backups.js';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { safeFilename } from '$lib/server/sanitize.js';

/** Validate backup filename format: matches both unencrypted (.zip) and passphrase-wrapped (.zip.enc). */
const BACKUP_FILENAME_RE = /^backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip(\.enc)?$/;

let backupInProgress = false;
let lastBackupTime = 0;
const MIN_BACKUP_INTERVAL_MS = 60_000; // 60 seconds between backups

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401);

	const download = url.searchParams.get('download');
	if (download) {
		if (!BACKUP_FILENAME_RE.test(download)) throw error(400, 'Invalid filename');
		const filePath = getBackupPath(download);
		if (!filePath) throw error(404, 'Backup not found');

		const safeName = safeFilename(download);
		let fileSize: number;
		let nodeStream;
		try {
			fileSize = statSync(filePath).size;
			nodeStream = createReadStream(filePath);
		} catch {
			throw error(404, 'Backup file not found on disk');
		}
		const webStream = Readable.toWeb(nodeStream) as ReadableStream;
		return new Response(webStream, {
			headers: {
				'Content-Type': 'application/zip',
				'Content-Length': String(fileSize),
				'Content-Disposition': `attachment; filename="${safeName}"`
			}
		});
	}

	return json(getBackups());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody<Record<string, unknown>>(request);
	const action = body.action as string;

	if (action === 'create') {
		if (backupInProgress) {
			throw error(429, 'A backup is already in progress');
		}
		const now = Date.now();
		if (now - lastBackupTime < MIN_BACKUP_INTERVAL_MS) {
			throw error(429, 'Please wait at least 60 seconds between backups');
		}
		backupInProgress = true;
		try {
			const backup = await createBackup();
			lastBackupTime = Date.now();
			return json(backup);
		} finally {
			backupInProgress = false;
		}
	}

	if (action === 'delete') {
		const filename = body.filename as string;
		if (!filename) throw error(400, 'Missing filename');
		if (!BACKUP_FILENAME_RE.test(filename)) throw error(400, 'Invalid filename');
		const ok = deleteBackup(filename);
		if (!ok) throw error(404, 'Backup not found');
		return json({ ok: true });
	}

	if (action === 'restore_preview') {
		const filename = body.filename as string;
		if (!filename) throw error(400, 'Missing filename');
		if (!BACKUP_FILENAME_RE.test(filename)) throw error(400, 'Invalid filename');
		try {
			const preview = await previewRestore(filename);
			return json(preview);
		} catch (e) {
			const msg = (e as Error).message;
			const isUserError = msg.startsWith('Invalid backup') || msg.includes('not found');
			throw error(isUserError ? 400 : 500, isUserError ? msg : 'Preview failed');
		}
	}

	if (action === 'restore') {
		const filename = body.filename as string;
		if (!filename) throw error(400, 'Missing filename');
		if (!BACKUP_FILENAME_RE.test(filename)) throw error(400, 'Invalid filename');
		try {
			await restoreBackup(filename);
		} catch (e) {
			const msg = (e as Error).message;
			// Surface only known validation errors; hide internal system errors
			const isUserError = msg.startsWith('Invalid backup') || msg.includes('limit') || msg.includes('not found');
			if (!isUserError) {
				console.error('Backup restore failed with unexpected error:', e);
			}
			throw error(isUserError ? 400 : 500, isUserError ? msg : 'Backup restore failed');
		}
		return json({ ok: true });
	}

	throw error(400, 'Invalid action');
};
