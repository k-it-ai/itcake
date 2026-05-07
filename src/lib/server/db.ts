import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { encryptField, decryptField } from './field-crypto.js';

const DB_PATH = process.env.DATABASE_PATH || 'data/itcake.db';

const resolved = path.resolve(DB_PATH);
const BLOCKED = ['/etc', '/dev', '/proc', '/sys', '/boot', '/sbin', '/bin', '/usr/sbin', '/usr/bin'];
for (const prefix of BLOCKED) {
	if (resolved === prefix || resolved.startsWith(prefix + '/')) {
		throw new Error(`DATABASE_PATH must not point to system directory "${prefix}". Got: ${resolved}`);
	}
}
if (/['\x00]/.test(resolved)) {
	throw new Error(`DATABASE_PATH must not contain single quotes or null bytes. Got: ${resolved}`);
}

const dataDir = path.dirname(resolved);
if (!fs.existsSync(dataDir)) {
	fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(resolved);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL'); // Safe with WAL; halves fsync overhead
db.pragma('cache_size = -16000'); // 16MB in-memory page cache
db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
db.pragma('busy_timeout = 5000'); // Wait up to 5s on lock contention instead of instant BUSY error
db.pragma('temp_store = MEMORY'); // Keep temp tables in RAM

db.exec(`
	CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		email TEXT UNIQUE NOT NULL,
		name TEXT NOT NULL DEFAULT '',
		password_hash TEXT NOT NULL,
		totp_secret TEXT NOT NULL DEFAULT '',
		totp_enabled INTEGER NOT NULL DEFAULT 0,
		totp_recovery_hashes TEXT NOT NULL DEFAULT '[]',
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);

	CREATE TABLE IF NOT EXISTS documents (
		id TEXT PRIMARY KEY,
		type TEXT NOT NULL CHECK (type IN ('invoice', 'proposal', 'client', 'unit', 'catalog_item', 'template', 'expense', 'ticket', 'custom_field_def', 'saved_filter')),
		data TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);

	CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);

	CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL DEFAULT '{}'
	);

	-- Audit log. The hash column is HMAC-SHA256 over (prev.hash || fields)
	-- keyed by SESSION_SECRET, forming a chain. Any row insert / delete /
	-- modification breaks verification downstream and is detectable by the
	-- built-in integrity check. Rows are immutable by design — pruned only
	-- wholesale at the tail (> 1 year).
	CREATE TABLE IF NOT EXISTS changes (
		id TEXT PRIMARY KEY,
		entity_type TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		action TEXT NOT NULL,
		diff TEXT NOT NULL DEFAULT '{}',
		user_id TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		hash TEXT NOT NULL DEFAULT ''
	);

	CREATE INDEX IF NOT EXISTS idx_changes_entity ON changes(entity_type, entity_id);
	CREATE INDEX IF NOT EXISTS idx_changes_created ON changes(created_at DESC);

	-- HMAC-anchored row count + last_hash so tail-truncation is detectable.
	CREATE TABLE IF NOT EXISTS audit_anchor (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		row_count INTEGER NOT NULL DEFAULT 0,
		last_hash TEXT NOT NULL DEFAULT '',
		anchor_hmac TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT ''
	);
	INSERT OR IGNORE INTO audit_anchor (id) VALUES (1);

	CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);

	CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
	CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

	-- Single-use tracker for MFA challenge tokens (see totp.ts).
	-- Each token carries a 16-byte nonce; consumeMfaChallenge inserts
	-- the nonce hash on a successful step-2 verify, blocking replay.
	CREATE TABLE IF NOT EXISTS mfa_used_challenges (
		nonce_hash TEXT PRIMARY KEY,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_mfa_used_challenges_expires_at
		ON mfa_used_challenges(expires_at);

	CREATE TABLE IF NOT EXISTS counters (
		key TEXT PRIMARY KEY,
		value INTEGER NOT NULL DEFAULT 0
	);

	-- Expression indexes for common json_extract filters
	CREATE INDEX IF NOT EXISTS idx_doc_invoice_status
		ON documents(type, json_extract(data, '$.status'))
		WHERE type = 'invoice';

	CREATE INDEX IF NOT EXISTS idx_doc_client_id
		ON documents(type, json_extract(data, '$.clientId'));

	CREATE INDEX IF NOT EXISTS idx_doc_due_date
		ON documents(type, json_extract(data, '$.dueDate'))
		WHERE type = 'invoice';

	CREATE INDEX IF NOT EXISTS idx_doc_document_id
		ON documents(type, json_extract(data, '$.documentId'));

	-- Expense date filtering (reports)
	CREATE INDEX IF NOT EXISTS idx_doc_expense_date
		ON documents(json_extract(data, '$.date'))
		WHERE type = 'expense';

	-- Proposal status filtering (getProposalsByStatus)
	CREATE INDEX IF NOT EXISTS idx_doc_proposal_status
		ON documents(type, json_extract(data, '$.status'))
		WHERE type = 'proposal';

	-- Recurring invoice lookups (processDueRecurringInvoices)
	CREATE INDEX IF NOT EXISTS idx_doc_recurring_next_run
		ON documents(json_extract(data, '$.recurring.nextRunDate'))
		WHERE type = 'invoice' AND json_extract(data, '$.recurring.enabled') = 1;

	-- Revenue/tax report queries (COALESCE paidDate/issueDate)
	CREATE INDEX IF NOT EXISTS idx_doc_invoice_paid_date
		ON documents(COALESCE(json_extract(data, '$.paidDate'), json_extract(data, '$.issueDate')))
		WHERE type = 'invoice' AND json_extract(data, '$.status') = 'paid';

	-- Uptime monitoring tables
	CREATE TABLE IF NOT EXISTS monitors (
		id TEXT PRIMARY KEY,
		data TEXT NOT NULL DEFAULT '{}',
		enabled INTEGER NOT NULL DEFAULT 1,
		status TEXT NOT NULL DEFAULT 'pending',
		last_checked_at TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);

	-- alert-rule evaluation hits this every 60 s.
	CREATE INDEX IF NOT EXISTS idx_monitors_enabled_status ON monitors(enabled, status);

	CREATE TABLE IF NOT EXISTS monitor_checks (
		id TEXT PRIMARY KEY,
		monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
		check_type TEXT NOT NULL CHECK (check_type IN ('ping', 'http', 'domain_expiry', 'ssl_expiry')),
		status TEXT NOT NULL CHECK (status IN ('up', 'down', 'error')),
		response_time_ms INTEGER,
		message TEXT NOT NULL DEFAULT '',
		checked_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_monitor_checks_lookup ON monitor_checks(monitor_id, checked_at DESC);
	CREATE INDEX IF NOT EXISTS idx_monitor_checks_prune ON monitor_checks(checked_at);

	CREATE TABLE IF NOT EXISTS monitor_daily (
		monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
		check_type TEXT NOT NULL CHECK (check_type IN ('ping', 'http', 'domain_expiry', 'ssl_expiry')),
		date TEXT NOT NULL,
		uptime_percent REAL NOT NULL DEFAULT 100,
		avg_response_ms INTEGER,
		total_checks INTEGER NOT NULL DEFAULT 0,
		failed_checks INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (monitor_id, check_type, date)
	);
	CREATE INDEX IF NOT EXISTS idx_monitor_daily_lookup ON monitor_daily(monitor_id, date DESC);

	-- Ticket indexes
	CREATE INDEX IF NOT EXISTS idx_doc_ticket_status
		ON documents(type, json_extract(data, '$.status'))
		WHERE type = 'ticket';
	CREATE INDEX IF NOT EXISTS idx_doc_ticket_date
		ON documents(json_extract(data, '$.date'))
		WHERE type = 'ticket';

	-- RMM: Agent registration
	CREATE TABLE IF NOT EXISTS agents (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		hostname TEXT NOT NULL DEFAULT '',
		os TEXT NOT NULL DEFAULT '',
		arch TEXT NOT NULL DEFAULT '',
		os_version TEXT NOT NULL DEFAULT '',
		agent_version TEXT NOT NULL DEFAULT '',
		token_hash TEXT NOT NULL UNIQUE,
		monitor_id TEXT,
		status TEXT NOT NULL DEFAULT 'pending'
			CHECK (status IN ('online', 'offline', 'pending', 'stale')),
		enabled INTEGER NOT NULL DEFAULT 1,
		last_seen_at TEXT,
		tags TEXT NOT NULL DEFAULT '[]',
		data TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	-- Hot paths on the agents table:
	--  - getAgentSummary: filter by enabled, GROUP BY status.
	--  - alertScopeFor / alerts.evaluate*: filter by status (offline/stale).
	--  - auto-update tick: filter by enabled + status != 'offline', then sort by last_auto_update_at.
	-- The composite (enabled, status, last_seen_at) covers all three plus
	-- the stale-detection scan; SQLite uses leading-column prefixes so the
	-- index also serves enabled-only and (enabled, status) queries.
	CREATE INDEX IF NOT EXISTS idx_agents_enabled_status ON agents(enabled, status, last_seen_at);

	-- Bearer-token lookup on every /api/rmm/* request — without this each
	-- check-in does a full table scan to find the matching agent row.
	CREATE INDEX IF NOT EXISTS idx_agents_token_hash ON agents(token_hash);

	-- RMM: One-time enrollment tokens
	CREATE TABLE IF NOT EXISTS agent_enrollment_tokens (
		id TEXT PRIMARY KEY,
		token_hash TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL DEFAULT '',
		expires_at TEXT NOT NULL,
		used_at TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);

	-- RMM: Time-series metrics (pruned to 48h, like monitor_checks)
	CREATE TABLE IF NOT EXISTS agent_metrics (
		id TEXT PRIMARY KEY,
		agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		cpu_percent REAL,
		memory_used_bytes INTEGER,
		memory_total_bytes INTEGER,
		disk_used_bytes INTEGER,
		disk_total_bytes INTEGER,
		load_avg_1 REAL,
		load_avg_5 REAL,
		load_avg_15 REAL,
		uptime_seconds INTEGER,
		data TEXT NOT NULL DEFAULT '{}',
		recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_agent_metrics_lookup ON agent_metrics(agent_id, recorded_at DESC);
	CREATE INDEX IF NOT EXISTS idx_agent_metrics_prune ON agent_metrics(recorded_at);

	-- RMM: Command queue + history
	CREATE TABLE IF NOT EXISTS agent_commands (
		id TEXT PRIMARY KEY,
		agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		type TEXT NOT NULL CHECK (type IN (
			'shell', 'script',
			'package_update', 'package_upgrade', 'package_install', 'package_uninstall',
			'software_update', 'os_update', 'check_os_updates',
			'service_action', 'system_info_refresh', 'reboot',
			'peripheral_scan', 'sensitive_data_scan',
			'filesystem_analysis', 'filesystem_cleanup',
			'network_discovery', 'network_baseline_compare',
			'collect_reliability',
			'boot_performance_collect',
			'hardware_warranty_collect',
			'cis_audit'
		)),
		payload TEXT NOT NULL DEFAULT '{}',
		signature TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'pending'
			CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'expired')),
		issued_at TEXT NOT NULL DEFAULT (datetime('now')),
		started_at TEXT,
		completed_at TEXT,
		exit_code INTEGER,
		stdout TEXT NOT NULL DEFAULT '',
		stderr TEXT NOT NULL DEFAULT '',
		timeout_seconds INTEGER NOT NULL DEFAULT 300,
		user_id TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_agent_commands_pending ON agent_commands(agent_id, status);
	-- created_at covers the ORDER BY in getPendingCommands so SQLite
	-- doesn't allocate a temp B-tree to sort the matched rows. Cheap;
	-- the table is bounded by the 5-min queue + history limit.
	CREATE INDEX IF NOT EXISTS idx_agent_commands_pending_sorted
		ON agent_commands(agent_id, status, created_at);

	-- RMM: Service inventory (upserted by agent)
	CREATE TABLE IF NOT EXISTS agent_services (
		agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'unknown',
		enabled INTEGER,
		data TEXT NOT NULL DEFAULT '{}',
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (agent_id, name)
	);

	-- RMM: System log events (errors / warnings / criticals from systemd
	-- journal, macOS unified log, Windows Event Log) shipped on inventory
	-- cycles. Pruned on the same cadence as agent_metrics.
	CREATE TABLE IF NOT EXISTS agent_events (
		id TEXT PRIMARY KEY,
		agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		level TEXT NOT NULL CHECK (level IN ('critical', 'error', 'warning')),
		source TEXT NOT NULL DEFAULT '',
		message TEXT NOT NULL,
		occurred_at TEXT NOT NULL,
		received_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_agent_events_lookup ON agent_events(agent_id, occurred_at DESC);
	CREATE INDEX IF NOT EXISTS idx_agent_events_prune ON agent_events(received_at);

	-- RMM: Recurring schedules. Hourly tick (in hooks.server.ts) finds
	-- enabled rows where next_run_at <= now, dispatches the corresponding
	-- signed command via the existing pipeline, and recomputes next_run_at.
	CREATE TABLE IF NOT EXISTS agent_schedules (
		id TEXT PRIMARY KEY,
		agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		type TEXT NOT NULL CHECK (type IN (
			'shell', 'script',
			'package_update', 'package_upgrade', 'package_install',
			'software_update', 'os_update', 'check_os_updates',
			'service_action', 'system_info_refresh', 'reboot',
			'peripheral_scan', 'sensitive_data_scan',
			'filesystem_analysis',
			'network_discovery', 'network_baseline_compare',
			'collect_reliability',
			'boot_performance_collect',
			'hardware_warranty_collect',
			'cis_audit'
		)),
		payload TEXT NOT NULL DEFAULT '{}',
		cron_expression TEXT NOT NULL,
		timeout_seconds INTEGER NOT NULL DEFAULT 300,
		enabled INTEGER NOT NULL DEFAULT 1,
		last_run_at TEXT,
		next_run_at TEXT NOT NULL,
		user_id TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(enabled, next_run_at);

	-- RMM: Package inventory (upserted by agent)
	CREATE TABLE IF NOT EXISTS agent_packages (
		agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		manager TEXT NOT NULL,
		name TEXT NOT NULL,
		version TEXT NOT NULL DEFAULT '',
		latest_version TEXT NOT NULL DEFAULT '',
		update_available INTEGER NOT NULL DEFAULT 0,
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (agent_id, manager, name)
	);
	-- getUpdatablePackages filters on (agent_id, update_available=1).
	-- The PK only covers (agent_id, manager, name) so the predicate filter
	-- runs after a full index seek; this composite makes it covered.
	CREATE INDEX IF NOT EXISTS idx_agent_packages_updatable
		ON agent_packages(agent_id, update_available);

	-- Remote desktop sessions (Apache Guacamole). One row per browser
	-- popup the operator opens. token_hash is HMAC-SHA256 of the random
	-- session token returned to the operator's UI; consumed_at is set when
	-- the popup HTML page renders (single-use). started_at / ended_at are
	-- updated when the WebSocket connects to guacd / disconnects.
	-- recording_path is the .guac file (Guacamole's wire-protocol recording)
	-- when settings.remoteDesktop.recordingEnabled is on.
	CREATE TABLE IF NOT EXISTS remote_sessions (
		id TEXT PRIMARY KEY,
		agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		protocol TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		consumed_at TEXT,
		started_at TEXT,
		ended_at TEXT,
		recording_path TEXT,
		client_ip TEXT NOT NULL DEFAULT '',
		user_agent TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_remote_sessions_token ON remote_sessions(token_hash);
	CREATE INDEX IF NOT EXISTS idx_remote_sessions_agent ON remote_sessions(agent_id);

	-- Alerting: rules evaluated each 60s tick. Reuse Telegram/email channels
	-- already configured in uptime settings. The "condition" column is JSON;
	-- its shape is determined by "scope" (see AlertCondition in
	-- src/lib/types.ts). "last_fired_at" enforces cooldown between
	-- identical-rule notifications so flapping doesn't spam.
	CREATE TABLE IF NOT EXISTS alert_rules (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		scope TEXT NOT NULL CHECK (scope IN ('agent_metric', 'agent_offline', 'agent_reboot_required', 'monitor_status')),
		condition TEXT NOT NULL DEFAULT '{}',
		cooldown_minutes INTEGER NOT NULL DEFAULT 60,
		channels TEXT NOT NULL DEFAULT '["telegram","email"]',
		actions TEXT NOT NULL DEFAULT '[]',
		last_fired_at TEXT,
		user_id TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);

	-- Backup verification ledger. Every successful backup gets an integrity
	-- row (cheap: header magic + GCM tag + zip catalog + sqlite integrity_check).
	-- A weekly rotation drops a 'restore' row produced by extracting the .zip
	-- (or .zip.enc) into a tmp DB and running the same validation restoreBackup
	-- would. recovery_readiness aggregates both into a 0..100 dashboard score.
	CREATE TABLE IF NOT EXISTS backup_verifications (
		id TEXT PRIMARY KEY,
		filename TEXT NOT NULL,
		type TEXT NOT NULL CHECK (type IN ('integrity', 'restore')),
		status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
		size_bytes INTEGER NOT NULL DEFAULT 0,
		duration_ms INTEGER NOT NULL DEFAULT 0,
		details TEXT NOT NULL DEFAULT '{}',
		started_at TEXT NOT NULL,
		completed_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_backup_verifications_lookup ON backup_verifications(type, completed_at DESC);
	CREATE INDEX IF NOT EXISTS idx_backup_verifications_filename ON backup_verifications(filename);

	-- Single-row table — application enforces id=1. Recomputed after every
	-- backup or verification; consumed read-only by the dashboard.
	CREATE TABLE IF NOT EXISTS recovery_readiness (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		score INTEGER NOT NULL DEFAULT 0,
		risk_factors TEXT NOT NULL DEFAULT '[]',
		last_successful_backup_at TEXT,
		last_integrity_at TEXT,
		last_test_restore_at TEXT,
		last_offsite_upload_at TEXT,
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	INSERT OR IGNORE INTO recovery_readiness (id) VALUES (1);

	-- Agent findings: one table for every collector category (peripheral,
	-- sensitive_data, network, filesystem, policy). Same shape as
	-- agent_events but a finding is *something the operator should review
	-- and resolve* (open/resolved/accepted lifecycle), whereas agent_events
	-- are syslog-style observability that times out. fingerprint is a
	-- hash of category+identity used for 24h dedup so the same finding
	-- doesn't replay every collector run.
	CREATE TABLE IF NOT EXISTS agent_findings (
		id TEXT PRIMARY KEY,
		agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		category TEXT NOT NULL CHECK (category IN ('peripheral', 'sensitive_data', 'network', 'filesystem', 'policy')),
		severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
		title TEXT NOT NULL,
		evidence TEXT NOT NULL DEFAULT '{}',
		fingerprint TEXT NOT NULL,
		state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'accepted', 'false_positive')),
		first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
		last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
		resolved_at TEXT,
		user_id TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_agent_findings_open ON agent_findings(agent_id, category, state, last_seen_at DESC);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_findings_fingerprint ON agent_findings(agent_id, category, fingerprint);

	-- Agent collector results: snapshots from agent collector runs (filesystem
	-- analysis, network discovery, reliability daily). Shape is collector-
	-- specific JSON so we don't need a per-collector schema; UI parses by kind.
	CREATE TABLE IF NOT EXISTS agent_collector_results (
		id TEXT PRIMARY KEY,
		agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		command_id TEXT,
		kind TEXT NOT NULL CHECK (kind IN ('filesystem_analysis', 'network_discovery', 'network_baseline', 'reliability_daily', 'peripheral_inventory', 'boot_performance', 'hardware_warranty', 'cis_audit')),
		payload TEXT NOT NULL DEFAULT '{}',
		recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_agent_collector_results_lookup ON agent_collector_results(agent_id, kind, recorded_at DESC);
	CREATE INDEX IF NOT EXISTS idx_agent_collector_results_prune ON agent_collector_results(recorded_at);

	-- AI brain: chat sessions, message history, tool execution audit, daily
	-- cost roll-up. The risk-tier guardrail runs server-side (lib/server/ai/
	-- guardrails.ts) — Tier 3 tool calls insert a 'pending' row here and an
	-- in-process Promise resolver waits for the operator's approve/reject
	-- POST. The audit trail is the row, the synchronisation primitive is
	-- the in-memory Map.
	CREATE TABLE IF NOT EXISTS ai_sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		title TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL,
		approval_mode TEXT NOT NULL DEFAULT 'per_step' CHECK (approval_mode IN ('per_step', 'auto_approve_safe', 'plan')),
		page_context TEXT NOT NULL DEFAULT '{}',
		status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'flagged', 'expired')),
		total_input_tokens INTEGER NOT NULL DEFAULT 0,
		total_output_tokens INTEGER NOT NULL DEFAULT 0,
		total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
		total_cost_cents INTEGER NOT NULL DEFAULT 0,
		turn_count INTEGER NOT NULL DEFAULT 0,
		plan_steps TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_ai_sessions_user ON ai_sessions(user_id, updated_at DESC);

	CREATE TABLE IF NOT EXISTS ai_messages (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
		role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool_use', 'tool_result', 'system_event')),
		content_blocks TEXT NOT NULL DEFAULT '[]',
		tool_use_id TEXT,
		tool_name TEXT,
		input_tokens INTEGER,
		output_tokens INTEGER,
		cache_read_tokens INTEGER,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id, created_at);

	CREATE TABLE IF NOT EXISTS ai_tool_executions (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
		message_id TEXT,
		tool_name TEXT NOT NULL,
		tool_input TEXT NOT NULL DEFAULT '{}',
		tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3, 4)),
		status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'auto', 'completed', 'failed', 'expired')),
		approval_description TEXT,
		approved_by TEXT,
		approved_at TEXT,
		result_summary TEXT,
		duration_ms INTEGER,
		error_message TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		completed_at TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_ai_tool_executions_session ON ai_tool_executions(session_id, created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_ai_tool_executions_pending ON ai_tool_executions(status, created_at) WHERE status = 'pending';

	-- Single row per UTC day. Aggregates input + output + cache-read tokens
	-- and computed cost in cents (computed at row insert via the model's
	-- pricing — pricing changes only update future rows, the historical
	-- record stays accurate).
	CREATE TABLE IF NOT EXISTS ai_cost_daily (
		day TEXT PRIMARY KEY,
		input_tokens INTEGER NOT NULL DEFAULT 0,
		output_tokens INTEGER NOT NULL DEFAULT 0,
		cache_read_tokens INTEGER NOT NULL DEFAULT 0,
		cost_cents INTEGER NOT NULL DEFAULT 0,
		message_count INTEGER NOT NULL DEFAULT 0,
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
`);

db.prepare('DROP TABLE IF EXISTS agent_metrics_daily').run();

// command type is added to the server, existing DBs must have their CHECK
{
	const tblRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_commands'").get() as { sql: string } | undefined;
	const requiredTypes = [
		'shell', 'script',
		'package_update', 'package_upgrade', 'package_install', 'package_uninstall',
		'software_update', 'os_update', 'check_os_updates',
		'service_action', 'system_info_refresh', 'reboot',
		'peripheral_scan', 'sensitive_data_scan',
		'filesystem_analysis', 'filesystem_cleanup',
		'network_discovery', 'network_baseline_compare',
		'collect_reliability',
		'boot_performance_collect',
		'hardware_warranty_collect',
		'cis_audit'
	];
	if (tblRow && requiredTypes.some(t => !tblRow.sql.includes(`'${t}'`))) {
		db.pragma('foreign_keys = OFF');
		db.prepare(`CREATE TABLE IF NOT EXISTS agent_commands_new (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			type TEXT NOT NULL CHECK (type IN (
				'shell', 'script',
				'package_update', 'package_upgrade', 'package_install', 'package_uninstall',
				'software_update', 'os_update', 'check_os_updates',
				'service_action', 'system_info_refresh', 'reboot',
				'peripheral_scan', 'sensitive_data_scan',
				'filesystem_analysis', 'filesystem_cleanup',
				'network_discovery', 'network_baseline_compare',
				'collect_reliability',
				'boot_performance_collect'
			)),
			payload TEXT NOT NULL DEFAULT '{}',
			signature TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'expired')),
			issued_at TEXT NOT NULL DEFAULT (datetime('now')),
			started_at TEXT, completed_at TEXT,
			exit_code INTEGER,
			stdout TEXT NOT NULL DEFAULT '',
			stderr TEXT NOT NULL DEFAULT '',
			timeout_seconds INTEGER NOT NULL DEFAULT 300,
			user_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`).run();
		db.prepare('INSERT INTO agent_commands_new SELECT * FROM agent_commands').run();
		db.prepare('DROP TABLE agent_commands').run();
		db.prepare('ALTER TABLE agent_commands_new RENAME TO agent_commands').run();
		db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_commands_pending ON agent_commands(agent_id, status)').run();
		db.pragma('foreign_keys = ON');
	}
}

// the agent must be re-enrolled. Earlier code silently fell back to
{
	const cols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
	if (!cols.some(c => c.name === 'hmac_secret')) {
		db.prepare("ALTER TABLE agents ADD COLUMN hmac_secret TEXT NOT NULL DEFAULT ''").run();
	}
}

{
	const cols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
	if (!cols.some(c => c.name === 'enrolled_ip')) {
		db.prepare("ALTER TABLE agents ADD COLUMN enrolled_ip TEXT NOT NULL DEFAULT ''").run();
	}
	if (!cols.some(c => c.name === 'enrolled_user_agent')) {
		db.prepare("ALTER TABLE agents ADD COLUMN enrolled_user_agent TEXT NOT NULL DEFAULT ''").run();
	}
}

{
	const cols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
	if (!cols.some(c => c.name === 'last_auto_update_at')) {
		db.prepare("ALTER TABLE agents ADD COLUMN last_auto_update_at TEXT").run();
	}
}

{
	const cols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
	if (!cols.some(c => c.name === 'tags')) {
		db.prepare("ALTER TABLE agents ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'").run();
	}
}

{
	const rows = db.prepare("SELECT id, hmac_secret FROM agents WHERE hmac_secret != '' AND hmac_secret NOT LIKE 'enc%:%'").all() as { id: string; hmac_secret: string }[];
	if (rows.length > 0) {
		const stmt = db.prepare('UPDATE agents SET hmac_secret = ? WHERE id = ?');
		const tx = db.transaction(() => {
			for (const r of rows) {
				const encrypted = encryptField(r.hmac_secret, `agent.hmacSecret:${r.id}`);
				if (encrypted !== r.hmac_secret) stmt.run(encrypted, r.id);
			}
		});
		tx();
	}
}

{
	const rows = db.prepare("SELECT id, hmac_secret FROM agents WHERE hmac_secret LIKE 'enc2:%'").all() as { id: string; hmac_secret: string }[];
	if (rows.length > 0) {
		const stmt = db.prepare('UPDATE agents SET hmac_secret = ? WHERE id = ?');
		const tx = db.transaction(() => {
			for (const r of rows) {
				const plain = decryptField(r.hmac_secret);
				if (!plain) continue; // SESSION_SECRET unset or v2 corrupt — leave row alone.
				const upgraded = encryptField(plain, `agent.hmacSecret:${r.id}`);
				if (upgraded.startsWith('enc3:')) stmt.run(upgraded, r.id);
			}
		});
		tx();
	}
}

export function migrateUserTotpSecretsToV3(): number {
	const rows = db
		.prepare("SELECT id, totp_secret FROM users WHERE totp_secret LIKE 'enc2:%'")
		.all() as { id: string; totp_secret: string }[];
	if (rows.length === 0) return 0;
	const stmt = db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?');
	let migrated = 0;
	const tx = db.transaction(() => {
		for (const r of rows) {
			const plain = decryptField(r.totp_secret);
			if (!plain) continue;
			const upgraded = encryptField(plain, `users.totpSecret:${r.id}`);
			if (upgraded.startsWith('enc3:')) {
				stmt.run(upgraded, r.id);
				migrated++;
			}
		}
	});
	tx();
	return migrated;
}

export function migrateAgentRemoteDesktopToV3(): number {
	const rows = db
		.prepare("SELECT id, data FROM agents WHERE data LIKE '%enc2:%'")
		.all() as { id: string; data: string }[];
	if (rows.length === 0) return 0;
	const stmt = db.prepare('UPDATE agents SET data = ? WHERE id = ?');
	let migrated = 0;
	const tx = db.transaction(() => {
		for (const r of rows) {
			let parsed: Record<string, unknown>;
			try { parsed = JSON.parse(r.data); } catch { continue; }
			const rd = parsed.remoteDesktop as Record<string, unknown> | undefined;
			if (!rd || typeof rd !== 'object') continue;
			let changed = false;
			for (const field of ['password', 'privateKey'] as const) {
				const val = rd[field];
				if (typeof val !== 'string' || !val.startsWith('enc2:')) continue;
				const plain = decryptField(val);
				if (!plain) continue;
				const upgraded = encryptField(plain, `agent.remoteDesktop.${field}:${r.id}`);
				if (upgraded.startsWith('enc3:')) {
					rd[field] = upgraded;
					changed = true;
				}
			}
			if (changed) {
				stmt.run(JSON.stringify(parsed), r.id);
				migrated++;
			}
		}
	});
	tx();
	return migrated;
}

migrateUserTotpSecretsToV3();
migrateAgentRemoteDesktopToV3();

// B2 — re-wrap legacy enc2: settings credentials as enc3: with their stable
// per-field AAD. Reads happily fall back to enc2 (decryptSettingsValue) so
// this migration is purely a one-time forward-walk; if it fails for any
// reason (SESSION_SECRET wrong/missing, ciphertext corrupt) the row is left
// alone and the next operator save will perform the upgrade.
export function migrateSettingsCredentialsToV3(): number {
	const settingsAads: Array<{ key: string; path: string[]; label: string }> = [
		{ key: 'emails', path: ['smtp', 'pass'], label: 'emails.smtp.pass' },
		{ key: 'uptime', path: ['telegram', 'botToken'], label: 'uptime.telegram.botToken' },
		{ key: 'ai', path: ['apiKey'], label: 'ai.apiKey' },
		{ key: 'backup', path: ['encryptionPassphrase'], label: 'backup.encryptionPassphrase' },
		{ key: 'backup', path: ['offsite', 's3', 'secretAccessKey'], label: 'backup.offsite.s3.secretAccessKey' },
		{ key: 'backup', path: ['offsite', 'webdav', 'password'], label: 'backup.offsite.webdav.password' }
	];
	let migrated = 0;
	const stmtUpd = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
	const seen = new Map<string, Record<string, unknown>>();
	const tx = db.transaction(() => {
		for (const { key, path, label } of settingsAads) {
			let parsed = seen.get(key);
			if (!parsed) {
				const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
				if (!row) continue;
				try { parsed = JSON.parse(row.value); } catch { continue; }
				if (!parsed || typeof parsed !== 'object') continue;
				seen.set(key, parsed);
			}
			let cursor: unknown = parsed;
			for (let i = 0; i < path.length - 1; i++) {
				if (!cursor || typeof cursor !== 'object') { cursor = null; break; }
				cursor = (cursor as Record<string, unknown>)[path[i]];
			}
			if (!cursor || typeof cursor !== 'object') continue;
			const leaf = path[path.length - 1];
			const val = (cursor as Record<string, unknown>)[leaf];
			if (typeof val !== 'string' || !val.startsWith('enc2:')) continue;
			const plain = decryptField(val); // enc2 has no AAD
			if (!plain) continue;
			const upgraded = encryptField(plain, label);
			if (!upgraded.startsWith('enc3:')) continue;
			(cursor as Record<string, unknown>)[leaf] = upgraded;
		}
		for (const [key, parsed] of seen) {
			stmtUpd.run(JSON.stringify(parsed), key);
			migrated++;
		}
	});
	try { tx(); } catch (e) {
		console.warn('[settings] enc3 migration partial:', e instanceof Error ? e.message : e);
	}
	return migrated;
}

migrateSettingsCredentialsToV3();

{
	const tblRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_schedules'").get() as { sql: string } | undefined;
	const requiredTypes = [
		'shell', 'script',
		'package_update', 'package_upgrade', 'package_install',
		'software_update', 'os_update', 'check_os_updates',
		'service_action', 'system_info_refresh', 'reboot',
		'peripheral_scan', 'sensitive_data_scan',
		'filesystem_analysis',
		'network_discovery', 'network_baseline_compare',
		'collect_reliability',
		'boot_performance_collect',
		'hardware_warranty_collect',
		'cis_audit'
	];
	if (tblRow && requiredTypes.some(t => !tblRow.sql.includes(`'${t}'`))) {
		db.pragma('foreign_keys = OFF');
		db.prepare(`CREATE TABLE IF NOT EXISTS agent_schedules_new (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			type TEXT NOT NULL CHECK (type IN (
				'shell', 'script',
				'package_update', 'package_upgrade', 'package_install',
				'software_update', 'os_update', 'check_os_updates',
				'service_action', 'system_info_refresh', 'reboot',
				'peripheral_scan', 'sensitive_data_scan',
				'filesystem_analysis',
				'network_discovery', 'network_baseline_compare',
				'collect_reliability',
				'boot_performance_collect'
			)),
			payload TEXT NOT NULL DEFAULT '{}',
			cron_expression TEXT NOT NULL,
			timeout_seconds INTEGER NOT NULL DEFAULT 300,
			enabled INTEGER NOT NULL DEFAULT 1,
			last_run_at TEXT,
			next_run_at TEXT NOT NULL,
			user_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`).run();
		db.prepare('INSERT INTO agent_schedules_new SELECT * FROM agent_schedules').run();
		db.prepare('DROP TABLE agent_schedules').run();
		db.prepare('ALTER TABLE agent_schedules_new RENAME TO agent_schedules').run();
		db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(enabled, next_run_at)').run();
		db.pragma('foreign_keys = ON');
	}
}

{
	const tblRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_collector_results'").get() as { sql: string } | undefined;
	const requiredKinds = ['filesystem_analysis', 'network_discovery', 'network_baseline', 'reliability_daily', 'peripheral_inventory', 'boot_performance', 'hardware_warranty', 'cis_audit'];
	if (tblRow && requiredKinds.some(k => !tblRow.sql.includes(`'${k}'`))) {
		db.pragma('foreign_keys = OFF');
		db.prepare(`CREATE TABLE IF NOT EXISTS agent_collector_results_new (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			command_id TEXT,
			kind TEXT NOT NULL CHECK (kind IN ('filesystem_analysis', 'network_discovery', 'network_baseline', 'reliability_daily', 'peripheral_inventory', 'boot_performance', 'hardware_warranty', 'cis_audit')),
			payload TEXT NOT NULL DEFAULT '{}',
			recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`).run();
		db.prepare('INSERT INTO agent_collector_results_new SELECT * FROM agent_collector_results').run();
		db.prepare('DROP TABLE agent_collector_results').run();
		db.prepare('ALTER TABLE agent_collector_results_new RENAME TO agent_collector_results').run();
		db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_collector_results_lookup ON agent_collector_results(agent_id, kind, recorded_at DESC)').run();
		db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_collector_results_prune ON agent_collector_results(recorded_at)').run();
		db.pragma('foreign_keys = ON');
	}
}

{
	const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
	if (!cols.some(c => c.name === 'totp_secret')) {
		db.prepare("ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT ''").run();
	}
	if (!cols.some(c => c.name === 'totp_enabled')) {
		db.prepare("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0").run();
	}
	if (!cols.some(c => c.name === 'totp_recovery_hashes')) {
		db.prepare("ALTER TABLE users ADD COLUMN totp_recovery_hashes TEXT NOT NULL DEFAULT '[]'").run();
	}
}

{
	const cols = db.prepare("PRAGMA table_info(changes)").all() as { name: string }[];
	if (!cols.some(c => c.name === 'hash')) {
		db.prepare("ALTER TABLE changes ADD COLUMN hash TEXT NOT NULL DEFAULT ''").run();
	}
}

{
	const cols = db.prepare("PRAGMA table_info(alert_rules)").all() as { name: string }[];
	if (!cols.some(c => c.name === 'actions')) {
		db.prepare("ALTER TABLE alert_rules ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'").run();
	}
}

const rebuildDocumentsTable = db.transaction(() => {
	db.prepare(`
		CREATE TABLE documents_new (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL CHECK (type IN ('invoice', 'proposal', 'client', 'unit', 'catalog_item', 'template', 'expense', 'ticket', 'custom_field_def', 'saved_filter')),
			data TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`).run();
	db.prepare('INSERT INTO documents_new SELECT * FROM documents').run();
	db.prepare('DROP TABLE documents').run();
	db.prepare('ALTER TABLE documents_new RENAME TO documents').run();
	db.prepare('CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type)').run();
	db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_invoice_status
		ON documents(type, json_extract(data, '$.status'))
		WHERE type = 'invoice'`).run();
	db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_client_id
		ON documents(type, json_extract(data, '$.clientId'))`).run();
	db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_due_date
		ON documents(type, json_extract(data, '$.dueDate'))
		WHERE type = 'invoice'`).run();
	db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_document_id
		ON documents(type, json_extract(data, '$.documentId'))`).run();
	db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_expense_date
		ON documents(json_extract(data, '$.date'))
		WHERE type = 'expense'`).run();
	db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_proposal_status
		ON documents(type, json_extract(data, '$.status'))
		WHERE type = 'proposal'`).run();
	db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_recurring_next_run
		ON documents(json_extract(data, '$.recurring.nextRunDate'))
		WHERE type = 'invoice' AND json_extract(data, '$.recurring.enabled') = 1`).run();
	db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_invoice_paid_date
		ON documents(COALESCE(json_extract(data, '$.paidDate'), json_extract(data, '$.issueDate')))
		WHERE type = 'invoice' AND json_extract(data, '$.status') = 'paid'`).run();
	db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_ticket_status
		ON documents(type, json_extract(data, '$.status'))
		WHERE type = 'ticket'`).run();
	db.prepare(`CREATE INDEX IF NOT EXISTS idx_doc_ticket_date
		ON documents(json_extract(data, '$.date'))
		WHERE type = 'ticket'`).run();
});

const stmtProbeInsert = db.prepare("INSERT INTO documents (id, type, data) VALUES (?, ?, '{}')");
const stmtProbeDelete = db.prepare('DELETE FROM documents WHERE id = ?');

for (const [probeId, typeName] of [
	['__type_check__', 'expense'],
	['__type_check_ticket__', 'ticket'],
	['__type_check_custom_field_def__', 'custom_field_def'],
	['__type_check_saved_filter__', 'saved_filter']
]) {
	try {
		db.transaction(() => {
			stmtProbeInsert.run(probeId, typeName);
			stmtProbeDelete.run(probeId);
		})();
	} catch (e) {
		if (!(e instanceof Error && e.message.includes('CHECK constraint'))) throw e;
		rebuildDocumentsTable();
	}
}

const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');

const defaultSettings: Record<string, unknown> = {
	general: {
		language: 'de',
		currency: 'EUR',
		dateFormat: 'DD.MM.YYYY',
		timezone: 'Europe/Berlin'
	},
	company: {
		name: '',
		email: '',
		phone: '',
		website: '',
		taxNumber: '',
		vatNumber: '',
		registrationNumber: '',
		address: { street: '', city: '', zip: '', state: '', country: 'NL' },
		logoUrl: '',
		bankName: '',
		bankAccount: '',
		bankIban: '',
		bankSwift: '',
		legalInfo: ''
	},
	invoices: {
		idFormat: '{YYYY}-{####}',
		nextNumber: 1,
		defaultTemplate: 'kossov-it',
		defaultNotes: '',
		defaultFooter: '',
		defaultPricingMode: 'net',
		defaultTaxRate: 21,
		defaultPaymentTermDays: 30
	},
	proposals: {
		idFormat: 'P-{YYYY}-{####}',
		nextNumber: 1,
		defaultTemplate: 'kossov-it',
		defaultNotes: '',
		defaultFooter: '',
		defaultPricingMode: 'net',
		defaultTaxRate: 21,
		defaultValidDays: 30
	},
	emails: {
		smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '', fromName: '' },
		invoiceEmail: { subject: 'Invoice {documentId}', body: 'Please find the attached invoice.' },
		creditNoteEmail: { subject: 'Credit Note {documentId}', body: 'Please find the attached credit note.' },
		proposalEmail: { subject: 'Proposal {documentId}', body: 'Please find the attached proposal.' },
		reminderEmail: { subject: 'Reminder: Invoice {documentId}', body: 'This is a friendly reminder about the outstanding invoice.' }
	},
	advanced: {
		sepaQrEnabled: false,
		kleinunternehmer: false,
		editLock: 'none'
	},
	uptime: {
		telegram: { botToken: '', chatId: '', enabled: false },
		emailAlerts: false,
		alertEmail: ''
	},
	rmm: {
		defaultCheckinInterval: 30,
		staleThresholdMinutes: 2,
		metricsRetentionHours: 48,
		commandTimeoutSeconds: 300
	},
	remoteDesktop: {
		// Operator must explicitly enable; ITCake won't connect to a guacd
		enabled: false,
		guacdHost: '127.0.0.1',
		guacdPort: 4822,
		proxyPort: 4823,
		recordingEnabled: false,
		maxSessionMinutes: 60,
		tokenTtlSeconds: 300
	},
	ai: {
		// BYOK: operator pastes their own Anthropic API key. Encrypted at rest
		// via field-crypto enc3: with AAD `ai.apiKey:1`. Disabled by default
		// so a fresh install doesn't accidentally leak a leaked key — operator
		// has to flip enabled + paste the key.
		enabled: false,
		apiKey: '',                            // field-encrypted (enc3:)
		model: 'claude-opus-4-7',              // default per claude-api skill
		monthlyBudgetCents: 5000,              // $50 default; refuse new turns over this
		approvalMode: 'per_step',              // 'per_step' | 'auto_approve_safe' | 'plan'
		maxTurnsPerSession: 50,
		maxOutputTokensPerTurn: 16000,
		thinkingMode: 'adaptive',              // 'adaptive' | 'disabled'
		effort: 'high'                         // 'low' | 'medium' | 'high' | 'xhigh' | 'max'
	},
	backup: {
		encryptionPassphrase: '',
		offsite: {
			enabled: false,
			schedule: 'daily',          // 'daily' | 'weekly' | 'manual'
			target: 's3',               // 's3' | 'webdav'
			s3: {
				endpoint: '',           // e.g. https://s3.eu-central-003.backblazeb2.com
				region: 'us-east-1',
				bucket: '',
				accessKeyId: '',
				secretAccessKey: '',    // field-encrypted at rest
				pathPrefix: 'itcake/'
			},
			webdav: {
				url: '',                // e.g. https://your-server/dav/itcake/
				username: '',
				password: ''            // field-encrypted at rest
			},
			retentionDays: 30,          // delete remote backups older than this
			lastUpload: null            // { at, ok, error?, sizeBytes? }
		}
	}
};

const seedTransaction = db.transaction(() => {
	for (const [key, value] of Object.entries(defaultSettings)) {
		seedSetting.run(key, JSON.stringify(value));
	}
});

seedTransaction();

db.prepare('INSERT OR IGNORE INTO counters (key, value) VALUES (?, ?)').run('invoice_global', 0);
db.prepare('INSERT OR IGNORE INTO counters (key, value) VALUES (?, ?)').run('proposal_global', 0);
db.prepare('INSERT OR IGNORE INTO counters (key, value) VALUES (?, ?)').run('client_global', 0);
db.prepare('INSERT OR IGNORE INTO counters (key, value) VALUES (?, ?)').run('ticket_global', 0);
db.prepare('INSERT OR IGNORE INTO counters (key, value) VALUES (?, ?)').run('agent_global', 0);


const stmtGetDoc = db.prepare('SELECT data FROM documents WHERE id = ?');
const stmtGetDocTyped = db.prepare('SELECT data FROM documents WHERE id = ? AND type = ?');
const stmtGetDocsByType = db.prepare('SELECT data FROM documents WHERE type = ? ORDER BY created_at DESC LIMIT 10000');
const stmtInsertDoc = db.prepare('INSERT INTO documents (id, type, data) VALUES (?, ?, ?)');
const stmtUpdateDoc = db.prepare("UPDATE documents SET data = ?, updated_at = datetime('now') WHERE id = ?");
const stmtDeleteDoc = db.prepare('DELETE FROM documents WHERE id = ?');
const stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtSetSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

{
	const langRow = stmtGetSetting.get('general') as { value: string } | undefined;
	const lang = langRow ? JSON.parse(langRow.value)?.language : 'en';
	if (lang === 'de') {
		const emailRow = stmtGetSetting.get('emails') as { value: string } | undefined;
		if (emailRow) {
			const emails = JSON.parse(emailRow.value);
			let changed = false;
			const deDefaults: Record<string, { subject: string; body: string }> = {
				invoiceEmail: { subject: 'Rechnung {documentId}', body: 'Anbei erhalten Sie die Rechnung.' },
				creditNoteEmail: { subject: 'Gutschrift {documentId}', body: 'Anbei erhalten Sie die Gutschrift.' },
				proposalEmail: { subject: 'Angebot {documentId}', body: 'Anbei erhalten Sie das Angebot.' },
				reminderEmail: { subject: 'Erinnerung: Rechnung {documentId}', body: 'Dies ist eine freundliche Erinnerung an die ausstehende Rechnung.' }
			};
			const enDefaults: Record<string, { subject: string; body: string }> = {
				invoiceEmail: { subject: 'Invoice {documentId}', body: 'Please find the attached invoice.' },
				creditNoteEmail: { subject: 'Credit Note {documentId}', body: 'Please find the attached credit note.' },
				proposalEmail: { subject: 'Proposal {documentId}', body: 'Please find the attached proposal.' },
				reminderEmail: { subject: 'Reminder: Invoice {documentId}', body: 'This is a friendly reminder about the outstanding invoice.' }
			};
			for (const [key, en] of Object.entries(enDefaults)) {
				if (emails[key]?.subject === en.subject && emails[key]?.body === en.body) {
					emails[key] = deDefaults[key];
					changed = true;
				}
			}
			if (changed) stmtSetSetting.run('emails', JSON.stringify(emails));
		}
	}
}

export function generateId(): string {
	return crypto.randomUUID();
}

export function escapeSqlLike(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function parseSqliteUtc(s: string): number {
	return new Date(s.endsWith('Z') ? s : s + 'Z').getTime();
}

export function getDocument<T>(id: string, type?: DocumentType): T | null {
	const row = type
		? stmtGetDocTyped.get(id, type) as { data: string } | undefined
		: stmtGetDoc.get(id) as { data: string } | undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.data) as T;
	} catch (e) {
		console.error(`Corrupted JSON in document ${id}:`, e instanceof Error ? e.message : e);
		return null;
	}
}

type DocumentType = 'invoice' | 'proposal' | 'client' | 'unit' | 'catalog_item' | 'template' | 'expense' | 'ticket' | 'custom_field_def' | 'saved_filter';

export function getDocumentsByType<T>(type: DocumentType): T[] {
	const rows = stmtGetDocsByType.all(type) as { data: string }[];
	const results: T[] = [];
	for (const r of rows) {
		try {
			results.push(JSON.parse(r.data) as T);
		} catch (e) {
			console.error(`Corrupted JSON in ${type} document, skipping:`, e instanceof Error ? e.message : e);
		}
	}
	return results;
}

export interface PaginatedResult<T> {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
}

// Defensive runtime guard for filter fragments: the fragment may only contain
// json_extract paths, comparison operators, placeholders, AND/OR/IN, parens,
// quotes for SQL literals, ESCAPE '\\', whitespace, and word characters.
// Anything else is a programming error (caller spliced user input into SQL).
const SAFE_FRAGMENT_RE = /^[\sa-zA-Z0-9_.,()'?$=<>!\\-]+$/;
const FORBIDDEN_FRAGMENT_RE = /--|\/\*|\*\/|;/;

export function queryDocumentsPaginated<T>(
	type: DocumentType,
	options: {
		filters?: Array<{ sql: string; params: unknown[] }>;
		orderBy?: string;
		page?: number;
		pageSize?: number;
	} = {}
): PaginatedResult<T> {
	const page = Math.max(1, options.page ?? 1);
	const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 25));
	const ALLOWED_ORDER_BY = new Set(['created_at DESC', 'created_at ASC', 'updated_at DESC', 'updated_at ASC']);
	const orderBy = ALLOWED_ORDER_BY.has(options.orderBy ?? '') ? options.orderBy! : 'created_at DESC';

	const conditions = ['type = ?'];
	const params: unknown[] = [type];

	for (const f of options.filters ?? []) {
		if (!SAFE_FRAGMENT_RE.test(f.sql) || FORBIDDEN_FRAGMENT_RE.test(f.sql)) {
			throw new Error(`queryDocumentsPaginated: rejected unsafe SQL fragment "${f.sql.slice(0, 80)}"`);
		}
		const placeholders = (f.sql.match(/\?/g) ?? []).length;
		if (placeholders !== f.params.length) {
			throw new Error(`queryDocumentsPaginated: placeholder/param count mismatch (${placeholders} vs ${f.params.length}) in "${f.sql.slice(0, 80)}"`);
		}
		conditions.push(f.sql);
		params.push(...f.params);
	}

	const where = conditions.join(' AND ');

	const countRow = db.prepare(`SELECT COUNT(*) as total FROM documents WHERE ${where}`).get(...params) as { total: number };
	const rows = db.prepare(`SELECT data FROM documents WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
		.all(...params, pageSize, (page - 1) * pageSize) as { data: string }[];

	const items: T[] = [];
	for (const r of rows) {
		try { items.push(JSON.parse(r.data) as T); }
		catch (e) { console.error(`Corrupted JSON in ${type} document, skipping:`, e instanceof Error ? e.message : e); }
	}

	return { items, total: countRow.total, page, pageSize };
}

export function insertDocument(id: string, type: DocumentType, data: unknown): void {
	stmtInsertDoc.run(id, type, JSON.stringify(data));
}

export function updateDocument(id: string, data: unknown): boolean {
	const result = stmtUpdateDoc.run(JSON.stringify(data), id);
	return result.changes > 0;
}

export function deleteDocument(id: string): boolean {
	const result = stmtDeleteDoc.run(id);
	return result.changes > 0;
}

function isEncrypted(value: unknown): boolean {
	return typeof value === 'string' && /^enc\d*:/.test(value);
}

/**
 * Decrypt sensitive fields after reading a settings object from DB.
 *
 * Strict-mode: when SESSION_SECRET is set, a non-empty value that ISN'T
 * enc-prefixed is treated as a plaintext-downgrade attempt — we clear
 * it and log loudly. The operator must re-enter credentials. Without
 * this, a DB writer could swap `enc2:...` for chosen plaintext and the
 * server would use it as the SMTP password / Telegram bot token /
 * S3 secret as if it were decrypted from a valid ciphertext.
 */
// B2 — every settings credential gets a fixed AAD string so a DB writer who
// swaps one ciphertext blob for another (e.g. SMTP-pass into ai.apiKey)
// fails the GCM tag verification. The AAD strings are stable across the
// lifetime of the install. New writes go through `enc3:` (with AAD); legacy
// `enc2:` blobs (no AAD) still decrypt on read for backward compat, and a
// migration on first boot re-wraps them. The decrypt uses
// `decryptFieldStrict`-style two-pass: try enc3+AAD, then enc2 (no AAD).
const SETTINGS_FIELD_AADS: Record<string, string> = {
	'emails.smtp.pass': 'emails.smtp.pass:1',
	'uptime.telegram.botToken': 'uptime.telegram.botToken:1',
	'ai.apiKey': 'ai.apiKey:1',
	'backup.encryptionPassphrase': 'backup.encryptionPassphrase:1',
	'backup.offsite.s3.secretAccessKey': 'backup.offsite.s3.secretAccessKey:1',
	'backup.offsite.webdav.password': 'backup.offsite.webdav.password:1'
};

function decryptSettingsValue(value: string, label: string): string {
	const aad = SETTINGS_FIELD_AADS[label];
	// enc3: blobs require the AAD on decrypt (field-crypto fail-closes
	// without it). enc2: blobs were written with no AAD; passing AAD to
	// `decryptField` against an enc2 blob also fail-closes (correctly,
	// since silent AAD-bypass would defeat the v3 promise). Try the
	// AAD-bound path first, fall back to plain decrypt for legacy blobs.
	if (value.startsWith('enc3:') && aad) return decryptField(value, aad);
	if (value.startsWith('enc2:')) return decryptField(value);
	// Unknown prefix: route through decryptField which logs + fail-closes.
	return decryptField(value);
}

function decryptSettingsFields(key: string, data: Record<string, unknown>): void {
	const secretSet = !!process.env.SESSION_SECRET;
	const checkAndDecrypt = (obj: Record<string, unknown> | undefined, field: string, label: string) => {
		if (!obj) return;
		const v = obj[field];
		if (typeof v !== 'string' || v === '') return;
		if (isEncrypted(v)) {
			obj[field] = decryptSettingsValue(v, label);
			return;
		}
		if (secretSet) {
			console.error(`[settings] STRICT decrypt refused for ${label}: value is not enc-prefixed but SESSION_SECRET is set. Clearing the field; re-enter credentials.`);
			obj[field] = '';
		}
	};

	if (key === 'emails') {
		checkAndDecrypt(data.smtp as Record<string, unknown> | undefined, 'pass', 'emails.smtp.pass');
	} else if (key === 'uptime') {
		checkAndDecrypt(data.telegram as Record<string, unknown> | undefined, 'botToken', 'uptime.telegram.botToken');
	} else if (key === 'ai') {
		checkAndDecrypt(data, 'apiKey', 'ai.apiKey');
	} else if (key === 'backup') {
		checkAndDecrypt(data as Record<string, unknown>, 'encryptionPassphrase', 'backup.encryptionPassphrase');
		const offsite = data.offsite as Record<string, unknown> | undefined;
		const s3 = offsite?.s3 as Record<string, unknown> | undefined;
		const webdav = offsite?.webdav as Record<string, unknown> | undefined;
		checkAndDecrypt(s3, 'secretAccessKey', 'backup.offsite.s3.secretAccessKey');
		checkAndDecrypt(webdav, 'password', 'backup.offsite.webdav.password');
	}
}

function encryptSettingsFields(key: string, data: Record<string, unknown>): void {
	const maybeEncrypt = (obj: Record<string, unknown> | undefined, field: string, label: string) => {
		if (!obj) return;
		const v = obj[field];
		if (typeof v === 'string' && v && !isEncrypted(v)) {
			obj[field] = encryptField(v, SETTINGS_FIELD_AADS[label]);
		}
	};
	if (key === 'emails') {
		maybeEncrypt(data.smtp as Record<string, unknown> | undefined, 'pass', 'emails.smtp.pass');
	} else if (key === 'uptime') {
		maybeEncrypt(data.telegram as Record<string, unknown> | undefined, 'botToken', 'uptime.telegram.botToken');
	} else if (key === 'ai') {
		maybeEncrypt(data, 'apiKey', 'ai.apiKey');
	} else if (key === 'backup') {
		maybeEncrypt(data, 'encryptionPassphrase', 'backup.encryptionPassphrase');
		const offsite = data.offsite as Record<string, unknown> | undefined;
		maybeEncrypt(offsite?.s3 as Record<string, unknown> | undefined, 'secretAccessKey', 'backup.offsite.s3.secretAccessKey');
		maybeEncrypt(offsite?.webdav as Record<string, unknown> | undefined, 'password', 'backup.offsite.webdav.password');
	}
}

// returns it directly, so callers must NOT mutate the returned value
const settingsCache = new Map<string, unknown>();

export function getSetting<T>(key: string): T {
	const cached = settingsCache.get(key);
	if (cached !== undefined) return cached as T;

	const row = stmtGetSetting.get(key) as { value: string } | undefined;
	if (!row) {
		const fallback = defaultSettings[key];
		const value = fallback !== undefined ? (fallback as T) : ({} as T);
		settingsCache.set(key, value);
		return value;
	}
	try {
		const parsed = JSON.parse(row.value);
		decryptSettingsFields(key, parsed);
		settingsCache.set(key, parsed);
		return parsed as T;
	} catch (e) {
		console.error(`Corrupted JSON in setting "${key}":`, e instanceof Error ? e.message : e);
		const fallback = defaultSettings[key];
		const value = fallback !== undefined ? (fallback as T) : ({} as T);
		settingsCache.set(key, value);
		return value;
	}
}

export function setSetting(key: string, value: unknown): void {
	const clone = structuredClone(value) as Record<string, unknown>;
	encryptSettingsFields(key, clone);
	stmtSetSetting.run(key, JSON.stringify(clone));
	settingsCache.delete(key);
}

const stmtCounterUpsert = db.prepare('INSERT OR IGNORE INTO counters (key, value) VALUES (?, 0)');
const stmtCounterIncrement = db.prepare('UPDATE counters SET value = value + 1 WHERE key = ?');
const stmtCounterSetMin = db.prepare('UPDATE counters SET value = MAX(value, ?) WHERE key = ?');
const stmtCounterGet = db.prepare('SELECT value FROM counters WHERE key = ?');

export function getCounter(key: string): number {
	const row = stmtCounterGet.get(key) as { value: number } | undefined;
	return row?.value ?? 0;
}

export const incrementCounter = db.transaction((key: string): number => {
	stmtCounterUpsert.run(key);
	stmtCounterIncrement.run(key);
	const row = stmtCounterGet.get(key) as { value: number };
	return row.value;
});

export const incrementCounterWithMin = db.transaction((key: string, minValue: number): number => {
	stmtCounterUpsert.run(key);
	stmtCounterSetMin.run(minValue - 1, key);
	stmtCounterIncrement.run(key);
	const row = stmtCounterGet.get(key) as { value: number };
	return row.value;
});

const stmtUserCount = db.prepare('SELECT COUNT(*) as count FROM users');
const stmtInsertUser = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');

export const createFirstUser = db.transaction((id: string, email: string, name: string, passwordHash: string): boolean => {
	const row = stmtUserCount.get() as { count: number };
	if (row.count > 0) return false;
	stmtInsertUser.run(id, email, name, passwordHash);
	return true;
});

const stmtNullPaidDate = db.prepare(`
	SELECT id, data, updated_at FROM documents
	WHERE type = 'invoice'
	  AND json_extract(data, '$.status') = 'paid'
	  AND json_extract(data, '$.paidDate') IS NULL
`);
const stmtUpdateDocDirect = db.prepare("UPDATE documents SET data = ?, updated_at = datetime('now') WHERE id = ?");

const nullPaidDateRows = stmtNullPaidDate.all() as { id: string; data: string; updated_at: string }[];
if (nullPaidDateRows.length > 0) {
	console.warn(`[db] Fixing ${nullPaidDateRows.length} paid invoice(s) with missing paidDate`);
	const fixTx = db.transaction(() => {
		for (const row of nullPaidDateRows) {
			try {
				const parsed = JSON.parse(row.data);
				parsed.paidDate = row.updated_at.substring(0, 10);
				stmtUpdateDocDirect.run(JSON.stringify(parsed), row.id);
			} catch (e) {
				console.error(`[db] Failed to fix paidDate for invoice ${row.id}:`, e instanceof Error ? e.message : e);
			}
		}
	});
	fixTx();
}

function onShutdown() {
	try {
		db.pragma('wal_checkpoint(TRUNCATE)');
		db.close();
	} catch { /* best effort during shutdown */ }
}
process.on('SIGINT', onShutdown);
process.on('SIGTERM', onShutdown);

export { db };
