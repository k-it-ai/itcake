import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, requireUser } from '$lib/server/request-utils.js';
import { requireMfaStepUp } from '$lib/server/mfa-step-up.js';
import { recordChange } from '$lib/server/changes.js';
import {
	verifyBackupIntegrity,
	runBackupTestRestore,
	recomputeRecoveryReadiness,
	getRecoveryReadiness,
	listBackupVerifications
} from '$services/backup-verification.js';
import { BACKUP_FILENAME_RE } from '$services/backups.js';

function requireFilename(data: Record<string, unknown>): string {
	const filename = typeof data.filename === 'string' ? data.filename : '';
	if (!filename) throw error(400, 'Missing filename');
	if (!BACKUP_FILENAME_RE.test(filename)) throw error(400, 'Invalid filename');
	return filename;
}

export const GET: RequestHandler = async ({ locals, url }) => {
	requireUser(locals);
	const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
	return json({
		readiness: getRecoveryReadiness(),
		verifications: listBackupVerifications(limit)
	});
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			'verify-integrity': async (data, userId) => {
				// Same posture as `restore_preview` on /api/backups: decrypts
				// the on-disk archive and opens the embedded DB, leaking
				// metadata to any cookie-only attacker without MFA. Gate
				// with a step-up + audit-log entry.
				requireMfaStepUp(userId, data, 'backup verify-integrity');
				const filename = requireFilename(data);
				const result = await verifyBackupIntegrity(filename);
				recordChange('settings', `backup-verify:${filename}`, 'create', {
					verification: { old: null, new: { filename, status: result.status } }
				}, userId);
				return json(result);
			},
			'test-restore': async (data, userId) => {
				// Same as verify-integrity — test-restore decrypts + opens
				// + reads. MFA-gated and audit-logged.
				requireMfaStepUp(userId, data, 'backup test-restore');
				const filename = requireFilename(data);
				const result = await runBackupTestRestore(filename);
				recordChange('settings', `backup-test-restore:${filename}`, 'create', {
					testRestore: { old: null, new: { filename, status: result.status } }
				}, userId);
				return json(result);
			},
			recompute: async () => {
				return json(recomputeRecoveryReadiness());
			}
		}
	});
