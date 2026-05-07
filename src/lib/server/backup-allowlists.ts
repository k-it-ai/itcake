/**
 * Single source of truth for the at-rest allowlists used by both
 * `restoreBackup()` (full restore) and `runBackupTestRestore()` (the verification
 * ladder's restore-side dry-run). Every time a new document type, settings
 * key, audit-log entity/action, or counter is added, the corresponding
 * constant here gets the new entry and BOTH consumers pick it up. Without
 * this central list, the verification path silently drifts behind restore
 * and a test-restore would pass on a backup containing a row that real
 * restore would reject (or vice versa).
 *
 * Document type CHECK constraints in `db.ts` and the `__type_check_*`
 * probe loop are still separate — those have to stay in sync by hand
 * (see CLAUDE.md "Allowlists" table).
 */

export const BACKUP_VALID_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
	'invoice', 'proposal', 'client', 'unit', 'catalog_item',
	'template', 'expense', 'ticket', 'custom_field_def', 'saved_filter'
]);

export const BACKUP_VALID_SETTINGS_KEYS: ReadonlySet<string> = new Set([
	'general', 'company', 'invoices', 'proposals', 'emails',
	'advanced', 'uptime', 'rmm', 'backup', 'remoteDesktop', 'ai'
]);

export const BACKUP_VALID_ENTITY_TYPES: ReadonlySet<string> = new Set([
	'invoice', 'creditNote', 'proposal', 'client', 'catalog_item',
	'unit', 'expense', 'settings', 'template', 'monitor', 'ticket',
	'agent', 'alert_rule', 'remote_session', 'custom_field_def',
	'saved_filter', 'agent_finding', 'ai_session', 'ai_tool_execution'
]);

export const BACKUP_VALID_ACTIONS: ReadonlySet<string> = new Set([
	'create', 'update', 'delete', 'status_change', 'reopen',
	'send_email', 'connect', 'disconnect'
]);

export const BACKUP_VALID_COUNTER_KEYS: ReadonlySet<string> = new Set([
	'invoice_global', 'proposal_global', 'client_global',
	'ticket_global', 'agent_global'
]);
