import {
	getRecoveryReadiness,
	listBackupVerifications,
	verifyBackupIntegrity,
	runBackupTestRestore
} from '$services/backup-verification.js';
import { getBackups } from '$services/backups.js';
import { registerTool } from '../tool-registry.js';

registerTool('get_recovery_readiness', {
	definition: {
		name: 'get_recovery_readiness',
		description: 'Get the current backup recovery readiness score (0..100) plus risk factors and last-known timestamps for backup, integrity, test-restore, and off-site upload.',
		input_schema: { type: 'object', properties: {} }
	},
	handler: async () => getRecoveryReadiness()
});

registerTool('list_backup_verifications', {
	definition: {
		name: 'list_backup_verifications',
		description: 'List recent backup verifications (integrity checks + test-restores) with status and details.',
		input_schema: {
			type: 'object',
			properties: { limit: { type: 'number', minimum: 1, maximum: 100, default: 20 } }
		}
	},
	handler: async (input) => {
		const limit = typeof input.limit === 'number' ? input.limit : 20;
		return listBackupVerifications(limit);
	}
});

registerTool('verify_backup_integrity', {
	definition: {
		name: 'verify_backup_integrity',
		description: 'Run an integrity check against a specific backup file (decrypt header → verify GCM tag → parse zip → PRAGMA integrity_check on the extracted DB). Tier 2 (low-risk, but mutates the verifications ledger).',
		input_schema: {
			type: 'object',
			properties: { filename: { type: 'string', description: 'Backup filename, e.g. backup-2026-05-06-031500.zip.enc' } },
			required: ['filename']
		}
	},
	handler: async (input) => {
		const filename = String(input.filename);
		return await verifyBackupIntegrity(filename);
	}
});

registerTool('run_backup_test_restore', {
	definition: {
		name: 'run_backup_test_restore',
		description: 'Run a full test-restore: extract the backup into a temp DB and apply the same allowlist validation that the real restore path uses. Tier 2.',
		input_schema: {
			type: 'object',
			properties: { filename: { type: 'string' } },
			required: ['filename']
		}
	},
	handler: async (input) => {
		const filename = String(input.filename);
		return await runBackupTestRestore(filename);
	}
});

registerTool('list_backups', {
	definition: {
		name: 'list_backups',
		description: 'List all backup files (most recent first).',
		input_schema: { type: 'object', properties: {} }
	},
	handler: async () => getBackups()
});
