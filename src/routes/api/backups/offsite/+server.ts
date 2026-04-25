import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { runOffsiteBackup, testOffsiteBackupConfig } from '$services/backup-offsite.js';
import { getSetting } from '$lib/server/db.js';
import type { BackupSettings } from '$lib/types.js';

let inFlight = false;

/**
 * Admin operations for the off-site backup pipeline.
 *
 *   GET                  → status (last upload + redacted config snapshot)
 *   POST { test:true }   → connectivity test (uploads a 32-byte sentinel)
 *   POST { run:true }    → full backup + upload now (manual trigger)
 *
 * Credentials are NEVER returned in the GET response — the UI just
 * needs to know whether config is present, not what it contains.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
	const settings = getSetting<BackupSettings>('backup');
	const offsite = settings?.offsite;
	return json({
		enabled: !!offsite?.enabled,
		schedule: offsite?.schedule ?? 'daily',
		target: offsite?.target ?? 's3',
		s3Configured: !!(offsite?.s3?.endpoint && offsite?.s3?.bucket && offsite?.s3?.accessKeyId),
		webdavConfigured: !!(offsite?.webdav?.url && offsite?.webdav?.username),
		encryptionEnabled: !!settings?.encryptionPassphrase,
		lastUpload: offsite?.lastUpload ?? null
	});
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);
	const body = await parseJsonBody(request) as { test?: boolean; run?: boolean };

	if (inFlight) throw error(409, 'Off-site backup already running');
	inFlight = true;
	try {
		if (body.test) {
			return json(await testOffsiteBackupConfig());
		}
		if (body.run) {
			return json(await runOffsiteBackup());
		}
		throw error(400, 'Specify { test: true } or { run: true }');
	} finally {
		inFlight = false;
	}
};
