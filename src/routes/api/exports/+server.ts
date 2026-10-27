import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/request-utils.js';
import { rowsToCsv, csvResponseHeaders } from '#lib/server/csv.js';
import { getAgents } from '#services/agents.js';
import { listAllFindings } from '#services/agent-findings.js';
import { getChanges, recordChange, type ChangeEntityType } from '#lib/server/changes.js';
import type { FindingCategory, FindingState } from '#lib/types.js';

const KIND_VALUES = ['agents', 'findings', 'audit'] as const;
type Kind = (typeof KIND_VALUES)[number];

function isKind(s: string | null): s is Kind {
	return !!s && (KIND_VALUES as readonly string[]).includes(s);
}

const FINDING_CATEGORIES: ReadonlySet<FindingCategory> = new Set(['peripheral', 'sensitive_data', 'network', 'filesystem', 'policy']);
const FINDING_STATES: ReadonlySet<FindingState> = new Set(['open', 'resolved', 'accepted', 'false_positive']);
const ENTITY_TYPES: ReadonlySet<ChangeEntityType> = new Set([
	'invoice', 'creditNote', 'proposal', 'client', 'expense', 'settings', 'catalog_item',
	'unit', 'template', 'monitor', 'ticket', 'agent', 'alert_rule', 'remote_session',
	'custom_field_def', 'saved_filter', 'agent_finding', 'ai_session', 'ai_tool_execution'
]);

export const GET: RequestHandler = async ({ url, locals }) => {
	// Exports expose agent inventory and security findings; keep them admin-only.
	requireAdmin(locals);
	const userId = locals.user.id;

	const kind = url.searchParams.get('kind');
	if (!isKind(kind)) throw error(400, 'kind must be one of: agents, findings, audit');

	const today = new Date().toISOString().slice(0, 10);

	const filterSnapshot: Record<string, string> = {};
	for (const [k, v] of url.searchParams) {
		if (k === 'kind') continue;
		filterSnapshot[k] = v.slice(0, 100);
	}
	recordChange('settings', `export:${kind}`, 'create', { export: { old: null, new: { kind, filters: filterSnapshot } } }, userId);

	if (kind === 'agents') {
		const agents = getAgents();
		const csv = rowsToCsv(
			agents.map(a => ({
				id: a.id,
				name: a.name,
				hostname: a.hostname,
				os: a.os,
				osVersion: a.osVersion,
				arch: a.arch,
				agentVersion: a.agentVersion,
				status: a.status,
				enabled: a.enabled ? 'yes' : 'no',
				ip: a.ip,
				lastSeenAt: a.lastSeenAt ?? '',
				tags: (a.tags ?? []).join('; '),
				cpuModel: a.cpuModel,
				packageManagers: a.packageManagers.join('; ')
			})),
			[
				{ key: 'id', header: 'ID' },
				{ key: 'name', header: 'Name' },
				{ key: 'hostname', header: 'Hostname' },
				{ key: 'os', header: 'OS' },
				{ key: 'osVersion', header: 'OS version' },
				{ key: 'arch', header: 'Arch' },
				{ key: 'agentVersion', header: 'Agent version' },
				{ key: 'status', header: 'Status' },
				{ key: 'enabled', header: 'Enabled' },
				{ key: 'ip', header: 'IP' },
				{ key: 'lastSeenAt', header: 'Last seen' },
				{ key: 'tags', header: 'Tags' },
				{ key: 'cpuModel', header: 'CPU' },
				{ key: 'packageManagers', header: 'Package managers' }
			]
		);
		return new Response(csv, { headers: csvResponseHeaders(`agents-${today}.csv`) });
	}

	if (kind === 'findings') {
		const categoryRaw = url.searchParams.get('category');
		const stateRaw = url.searchParams.get('state');
		const category = categoryRaw && FINDING_CATEGORIES.has(categoryRaw as FindingCategory) ? (categoryRaw as FindingCategory) : undefined;
		const state = stateRaw && FINDING_STATES.has(stateRaw as FindingState) ? (stateRaw as FindingState) : undefined;
		const findings = listAllFindings({ category, state, limit: 10000 });
		const csv = rowsToCsv(
			findings.map(f => ({
				id: f.id,
				agentId: f.agentId,
				category: f.category,
				severity: f.severity,
				state: f.state,
				title: f.title,
				evidence: f.evidence,
				fingerprint: f.fingerprint,
				firstSeenAt: f.firstSeenAt,
				lastSeenAt: f.lastSeenAt,
				resolvedAt: f.resolvedAt ?? ''
			})),
			[
				{ key: 'id', header: 'ID' },
				{ key: 'agentId', header: 'Agent' },
				{ key: 'category', header: 'Category' },
				{ key: 'severity', header: 'Severity' },
				{ key: 'state', header: 'State' },
				{ key: 'title', header: 'Title' },
				{ key: 'evidence', header: 'Evidence (JSON)' },
				{ key: 'fingerprint', header: 'Fingerprint' },
				{ key: 'firstSeenAt', header: 'First seen' },
				{ key: 'lastSeenAt', header: 'Last seen' },
				{ key: 'resolvedAt', header: 'Resolved at' }
			]
		);
		return new Response(csv, { headers: csvResponseHeaders(`findings-${today}.csv`) });
	}

	const limit = Math.min(50000, Math.max(1, Number(url.searchParams.get('limit') ?? 10000)));
	const entityRaw = url.searchParams.get('entityType');
	const entityIdRaw = url.searchParams.get('entityId');
	const entityType = entityRaw && ENTITY_TYPES.has(entityRaw as ChangeEntityType) ? (entityRaw as ChangeEntityType) : undefined;
	const entityId = entityIdRaw && entityIdRaw.length > 0 ? entityIdRaw : undefined;

	const changes = entityType && entityId
		? getChanges(limit, entityType, entityId)
		: entityType
			? getChanges(limit, entityType)
			: getChanges(limit);

	const csv = rowsToCsv(
		changes.map(c => ({
			id: c.id,
			createdAt: c.createdAt,
			entityType: c.entityType,
			entityId: c.entityId,
			action: c.action,
			userId: c.userId ?? '',
			diff: c.diff,
			hash: c.hash
		})),
		[
			{ key: 'id', header: 'ID' },
			{ key: 'createdAt', header: 'Timestamp' },
			{ key: 'entityType', header: 'Entity type' },
			{ key: 'entityId', header: 'Entity id' },
			{ key: 'action', header: 'Action' },
			{ key: 'userId', header: 'User' },
			{ key: 'diff', header: 'Diff (JSON)' },
			{ key: 'hash', header: 'Chain hash' }
		]
	);
	return new Response(csv, { headers: csvResponseHeaders(`audit-${today}.csv`) });
};
