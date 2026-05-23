export const BACKUP_VALID_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
	'invoice', 'proposal', 'client', 'unit', 'catalog_item',
	'template', 'expense', 'ticket', 'custom_field_def', 'saved_filter'
]);

export const BACKUP_VALID_SETTINGS_KEYS: ReadonlySet<string> = new Set([
	'general', 'company', 'invoices', 'proposals', 'emails',
	'advanced', 'uptime', 'rmm', 'backup', 'remoteDesktop', 'ai', 'telemetry'
]);

export const BACKUP_VALID_ENTITY_TYPES: ReadonlySet<string> = new Set([
	'invoice', 'creditNote', 'proposal', 'client', 'catalog_item',
	'unit', 'expense', 'settings', 'template', 'monitor', 'ticket',
	'agent', 'alert_rule', 'remote_session', 'custom_field_def',
	'saved_filter', 'agent_finding', 'ai_session', 'ai_tool_execution'
]);

export const BACKUP_VALID_ACTIONS: ReadonlySet<string> = new Set([
	'create', 'update', 'delete', 'status_change', 'reopen',
	'send_email', 'connect', 'disconnect', 'convert'
]);

export const BACKUP_VALID_COUNTER_KEYS: ReadonlySet<string> = new Set([
	'invoice_global', 'proposal_global', 'client_global',
	'ticket_global', 'agent_global'
]);
