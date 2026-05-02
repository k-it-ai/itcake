import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, requireUser } from '$lib/server/request-utils.js';
import {
	createBackup, getBackups, getBackupPath, deleteBackup, restoreBackup,
	previewRestore, withBackupLock, BackupInProgressError
} from '$services/backups.js';
import { verifyUserPassword } from '$lib/server/auth.js';
import { recordChange } from '$lib/server/changes.js';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { safeFilename } from '$lib/server/sanitize.js';

const BACKUP_FILENAME_RE = /^backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip(\.enc)?$/;

let lastBackupTime = 0;
const MIN_BACKUP_INTERVAL_MS = 60_000; // 60 seconds between backups

function requireFilename(data: Record<string, unknown>): string {
	const filename = typeof data.filename === 'string' ? data.filename : '';
	if (!filename) throw error(400, 'Missing filename');
	if (!BACKUP_FILENAME_RE.test(filename)) throw error(400, 'Invalid filename');
	return filename;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	requireUser(locals);

	const download = url.searchParams.get('download');
	if (download) {
		if (!BACKUP_FILENAME_RE.test(download)) throw error(400, 'Invalid filename');
		const filePath = getBackupPath(download);
		if (!filePath) throw notFound();

		const safeName = safeFilename(download);
		let fileSize: number;
		let nodeStream;
		try {
			fileSize = statSync(filePath).size;
			nodeStream = createReadStream(filePath);
		} catch {
			throw notFound();
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

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			create: async () => {
				const now = Date.now();
				if (now - lastBackupTime < MIN_BACKUP_INTERVAL_MS) {
					throw error(429, 'Please wait at least 60 seconds between backups');
				}
				try {
					return await withBackupLock(async () => {
						const backup = await createBackup();
						lastBackupTime = Date.now();
						return json(backup);
					});
				} catch (e) {
					if (e instanceof BackupInProgressError) throw error(429, e.message);
					throw e;
				}
			},
			delete: (data) => {
				const filename = requireFilename(data);
				if (!deleteBackup(filename)) throw notFound();
				return json({ ok: true });
			},
			restore_preview: async (data) => {
				const filename = requireFilename(data);
				try {
					return json(await previewRestore(filename));
				} catch (e) {
					const msg = (e as Error).message;
					const isUserError = msg.startsWith('Invalid backup') || msg.includes('not found');
					throw error(isUserError ? 400 : 500, isUserError ? msg : 'Preview failed');
				}
			},
			restore: async (data, userId) => {
				const filename = requireFilename(data);

				const password = typeof data.password === 'string' ? data.password : '';
				if (!password) throw error(400, 'Password required to restore');
				const ok = await verifyUserPassword(userId, password);
				if (!ok) {
					recordChange('settings', filename, 'update', { restoreAttempt: { old: null, new: 'password_invalid' } }, userId);
					throw error(401, 'Password incorrect');
				}
				recordChange('settings', filename, 'update', { restoreAttempt: { old: null, new: 'authorized' } }, userId);

				try {
					await restoreBackup(filename);
				} catch (e) {
					const msg = (e as Error).message;
					const isUserError = msg.startsWith('Invalid backup') || msg.includes('limit') || msg.includes('not found');
					if (!isUserError) {
						console.error('Backup restore failed with unexpected error:', e);
					}
					throw error(isUserError ? 400 : 500, isUserError ? msg : 'Backup restore failed');
				}
				return json({ ok: true });
			}
		}
	});
