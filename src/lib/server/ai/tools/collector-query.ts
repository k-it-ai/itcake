import { queryCollectorResults } from '#services/collector-query.js';
import { listCollectorTables, COLLECTOR_TABLES } from '#lib/server/collector-tables.js';
import { registerTool } from '../tool-registry.js';
import type { CollectorResultKind } from '#lib/types.js';
import type { FilterCondition } from '#lib/server/filter-engine.js';

const KINDS = Object.keys(COLLECTOR_TABLES) as CollectorResultKind[];

registerTool('list_collector_tables', {
	definition: {
		name: 'list_collector_tables',
		description: 'Discover the queryable shape of agent collector results: which kinds exist, their description, the rowsPath (if any) and the columns + types you can filter on. Read this before calling query_collector_results.',
		input_schema: {
			type: 'object',
			properties: {}
		}
	},
	handler: async () => listCollectorTables()
});

registerTool('query_collector_results', {
	definition: {
		name: 'query_collector_results',
		description: 'Run a typed filter against an agent\'s collector results (peripheral_inventory, network_discovery, cis_audit, reliability_daily, boot_performance, hardware_warranty, network_baseline, filesystem_analysis). Tier 1 — read-only. Use list_collector_tables to discover columns and operator types per kind. The where[] grammar matches query_agents (eq, neq, contains, in, lt/gt, before/after, within_last_days, is_null, has_any). Each kind has either a rowsPath (one row per element of that array) or a snapshot row.',
		input_schema: {
			type: 'object',
			properties: {
				agentId: { type: 'string', description: 'Agent UUID' },
				kind: { type: 'string', enum: KINDS, description: 'Collector kind to query' },
				where: {
					type: 'array',
					maxItems: 50,
					items: {
						type: 'object',
						properties: {
							field: { type: 'string' },
							operator: { type: 'string', enum: ['eq', 'neq', 'contains', 'starts_with', 'ends_with', 'in', 'not_in', 'lt', 'lte', 'gt', 'gte', 'before', 'after', 'within_last_minutes', 'within_last_days', 'is_null', 'is_not_null', 'has_any'] },
							value: {}
						},
						required: ['field', 'operator']
					}
				},
				columns: {
					type: 'array',
					items: { type: 'string' },
					description: 'Optional projection; omit to return all registered columns'
				},
				limit: { type: 'number', minimum: 1, maximum: 200, default: 50 }
			},
			required: ['agentId', 'kind']
		}
	},
	handler: async (input) => {
		const agentId = String(input.agentId);
		const kind = String(input.kind) as CollectorResultKind;
		if (!(kind in COLLECTOR_TABLES)) {
			return { error: `unknown kind "${kind}". Use list_collector_tables to discover valid kinds.` };
		}
		const where = Array.isArray(input.where) ? (input.where as FilterCondition[]) : [];
		const columns = Array.isArray(input.columns) ? (input.columns as unknown[]).map(String) : undefined;
		const limit = typeof input.limit === 'number' ? input.limit : undefined;
		try {
			return queryCollectorResults({ agentId, kind, where, columns, limit });
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		}
	}
});
