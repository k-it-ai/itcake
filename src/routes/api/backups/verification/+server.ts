import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, requireUser } from '$lib/server/request-utils.js';
import {
	verifyBackupIntegrity,
	runBackupTestRestore,
	recomputeRecoveryReadiness,
	getRecoveryReadiness,
	listBackupVerifications
} from '$services/backup-verification.js';

const BACKUP_FILENAME_RE = /^backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip(\.enc)?$/;

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
			'verify-integrity': async (data) => {
				const filename = requireFilename(data);
				return json(await verifyBackupIntegrity(filename));
			},
			'test-restore': async (data) => {
				const filename = requireFilename(data);
				return json(await runBackupTestRestore(filename));
			},
			recompute: async () => {
				return json(recomputeRecoveryReadiness());
			}
		}
	});
