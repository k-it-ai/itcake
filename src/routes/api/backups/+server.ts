import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, requireUser } from '$lib/server/request-utils.js';
import {
	createBackup, getBackups, getBackupPath, deleteBackup, restoreBackup,
	previewRestore, withBackupLock, BackupInProgressError, BACKUP_FILENAME_RE,
	rotateBackupPassphrase, getBackupPassphrase
} from '$services/backups.js';
import { getSetting, setSetting } from '$lib/server/db.js';
import { recordTaskRun } from '$lib/server/task-runs.js';
import { verifyUserPassword } from '$lib/server/auth.js';
import { recordChange } from '$lib/server/changes.js';
import { requireMfaStepUp } from '$lib/server/mfa-step-up.js';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { safeFilename } from '$lib/server/sanitize.js';

let lastBackupTime = 0;
const MIN_BACKUP_INTERVAL_MS = 60_000;

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
			create: async (_data, userId) => {
				const now = Date.now();
				if (now - lastBackupTime < MIN_BACKUP_INTERVAL_MS) {
					throw error(429, 'Please wait at least 60 seconds between backups');
				}
				try {
					return await withBackupLock(async () => {
						const backup = await createBackup();
						lastBackupTime = Date.now();
						recordChange('settings', backup.filename, 'create', { backup: { old: null, new: { filename: backup.filename, size: backup.size } } }, userId);
						return json(backup);
					});
				} catch (e) {
					if (e instanceof BackupInProgressError) throw error(429, e.message);
					throw e;
				}
			},
			delete: (data, userId) => {
				const filename = requireFilename(data);
				requireMfaStepUp(userId, data, 'backup delete');
				if (!deleteBackup(filename)) throw notFound();
				recordChange('settings', filename, 'delete', { backup: { old: { filename }, new: null } }, userId);
				return json({ ok: true });
			},
			restore_preview: async (data, userId) => {
				requireMfaStepUp(userId, data, 'backup restore-preview');
				const filename = requireFilename(data);
				try {
					return json(await previewRestore(filename));
				} catch (e) {
					const msg = (e as Error).message;
					const isUserError = msg.startsWith('Invalid backup') || msg.includes('not found');
					throw error(isUserError ? 400 : 500, isUserError ? msg : 'Preview failed');
				}
			},
			rotate_passphrase: async (data, userId) => {
				const password = typeof data.password === 'string' ? data.password : '';
				if (!password) throw error(400, 'Password required');
				const ok = await verifyUserPassword(userId, password);
				if (!ok) throw error(401, 'Password incorrect');
				requireMfaStepUp(userId, data, 'backup passphrase rotation');

				const newPassphrase = typeof data.newPassphrase === 'string' ? data.newPassphrase : '';
				if (newPassphrase.length < 8) throw error(400, 'newPassphrase must be at least 8 characters');

				let oldPassphrase: string;
				try { oldPassphrase = getBackupPassphrase(); }
				catch (e) { throw error(400, (e as Error).message); }
				if (!oldPassphrase) throw error(400, 'No current passphrase set; configure one via settings first');
				if (oldPassphrase === newPassphrase) throw error(400, 'newPassphrase must differ from current');

				const result = await recordTaskRun(
					'backup_passphrase_rotate',
					() => withBackupLock(async () => rotateBackupPassphrase(oldPassphrase, newPassphrase)),
					(r) => ({ rotated: r.rotated.length, skipped: r.skippedPlaintext.length, failed: r.failed.length })
				);

				const backupSection = getSetting<Record<string, unknown>>('backup') ?? {};
				setSetting('backup', { ...backupSection, encryptionPassphrase: newPassphrase });

				recordChange(
					'settings', 'backup', 'update',
					{ encryptionPassphrase: { old: '***', new: '***' }, rotated: { old: null, new: result.rotated.length } },
					userId
				);

				return json({
					ok: true,
					rotated: result.rotated.length,
					skippedPlaintext: result.skippedPlaintext.length,
					failed: result.failed
				});
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
				requireMfaStepUp(userId, data, 'backup restore');
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
				// First entry in the post-restore audit chain — pre-restore "authorized" was wiped by restore.
				recordChange('settings', filename, 'update',
					{ restoreCompleted: { old: null, new: new Date().toISOString() } },
					userId
				);
				return json({ ok: true });
			}
		}
	});
