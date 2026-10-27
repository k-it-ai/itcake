import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/request-utils.js';
import { COLLECTOR_TABLES } from '#lib/server/collector-tables.js';
import { isQueryableCollectorKind, osqueryNdjson } from '#lib/server/osquery-export.js';
import { listCollectorResults } from '#services/agent-collector-results.js';
import { getAgent } from '#services/agents.js';
import { recordChange } from '#lib/server/changes.js';

export const GET: RequestHandler = async ({ url, locals }) => {
	requireAdmin(locals);
	const userId = locals.user.id;

	const kindRaw = url.searchParams.get('kind');
	if (!kindRaw || !isQueryableCollectorKind(kindRaw)) {
		throw error(400, `kind must be one of: ${Object.keys(COLLECTOR_TABLES).join(', ')}`);
	}

	const agentId = url.searchParams.get('agentId');
	if (!agentId) throw error(400, 'agentId is required');

	const agent = getAgent(agentId);
	if (!agent) throw error(404, 'agent not found');

	const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
	const snapshots = listCollectorResults(agentId, kindRaw, limit);

	recordChange('settings', `export:osquery:${kindRaw}`, 'create', {
		export: { old: null, new: { kind: 'osquery', collectorKind: kindRaw, agentId, limit } }
	}, userId);

	const body = osqueryNdjson(snapshots, agent.hostname);
	const filename = `osquery-${kindRaw}-${agent.id}-${new Date().toISOString().slice(0, 10)}.ndjson`;
	return new Response(body, {
		headers: {
			'Content-Type': 'application/x-ndjson; charset=utf-8',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'no-store'
		}
	});
};
