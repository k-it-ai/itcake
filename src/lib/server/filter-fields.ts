import { db } from './db.js';
import type { FilterFieldDef } from './filter-engine.js';

const STATIC_AGENT_FIELDS: FilterFieldDef[] = [
	{ key: 'name', label: 'Name', type: 'string', column: 'name' },
	{ key: 'hostname', label: 'Hostname', type: 'string', column: 'hostname' },
	{ key: 'os', label: 'OS', type: 'enum', column: 'os', enumValues: ['darwin', 'linux', 'windows'] },
	{ key: 'arch', label: 'Architecture', type: 'enum', column: 'arch', enumValues: ['amd64', 'arm64', '386'] },
	{ key: 'osVersion', label: 'OS version', type: 'string', column: 'os_version' },
	{ key: 'agentVersion', label: 'Agent version', type: 'string', column: 'agent_version' },
	{ key: 'status', label: 'Status', type: 'enum', column: 'status', enumValues: ['online', 'offline', 'pending', 'stale'] },
	{ key: 'enabled', label: 'Enabled', type: 'boolean', column: 'enabled' },
	{ key: 'lastSeenAt', label: 'Last seen', type: 'date', column: 'last_seen_at' },
	{ key: 'createdAt', label: 'Enrolled', type: 'date', column: 'created_at' },
	{ key: 'tags', label: 'Tags', type: 'array', column: 'tags' },
	{ key: 'rebootRequired', label: 'Reboot required', type: 'boolean', column: "json_extract(data, '$.rebootRequired')" }
];

interface CustomFieldDefDoc {
	name: string;
	fieldKey: string;        // ^[a-z][a-z0-9_]{0,31}$
	type: 'text' | 'number' | 'boolean' | 'date' | 'enum';
	enumValues?: string[];
	appliesTo: string[];     // entity types: 'invoice'|'ticket'|'agent'|...
}

const CUSTOM_TYPE_TO_FILTER_TYPE: Record<CustomFieldDefDoc['type'], 'string' | 'number' | 'boolean' | 'date' | 'enum'> = {
	text: 'string', number: 'number', boolean: 'boolean', date: 'date', enum: 'enum'
};

function readCustomFieldDefs(appliesTo: string): FilterFieldDef[] {
	const rows = db.prepare(
		"SELECT data FROM documents WHERE type = 'custom_field_def'"
	).all() as { data: string }[];
	const defs: FilterFieldDef[] = [];
	for (const r of rows) {
		let parsed: CustomFieldDefDoc;
		try { parsed = JSON.parse(r.data) as CustomFieldDefDoc; } catch { continue; }
		if (!Array.isArray(parsed.appliesTo) || !parsed.appliesTo.includes(appliesTo)) continue;
		if (typeof parsed.fieldKey !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(parsed.fieldKey)) continue;
		const type = CUSTOM_TYPE_TO_FILTER_TYPE[parsed.type];
		if (!type) continue;
		const column = `json_extract(data, '$.custom.${parsed.fieldKey}')`;
		defs.push({
			key: `custom.${parsed.fieldKey}`,
			label: parsed.name,
			type,
			column,
			enumValues: type === 'enum' ? parsed.enumValues : undefined
		});
	}
	return defs;
}

export function buildAgentFieldRegistry(): ReadonlyMap<string, FilterFieldDef> {
	const m = new Map<string, FilterFieldDef>();
	for (const f of STATIC_AGENT_FIELDS) m.set(f.key, f);
	for (const f of readCustomFieldDefs('agent')) m.set(f.key, f);
	return m;
}
