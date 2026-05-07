import { db } from './db.js';
import type { FilterFieldDef } from './filter-engine.js';

/**
 * Built-in field registries. Custom fields (rows of type='custom_field_def')
 * are appended at registry-build time so the operator can extend the filter
 * surface without code changes.
 */

const STATIC_DOCUMENT_FIELDS: Record<string, FilterFieldDef[]> = {
	invoice: [
		{ key: 'documentId', label: 'Document ID', type: 'string', column: "json_extract(data, '$.documentId')" },
		{ key: 'status', label: 'Status', type: 'enum', column: "json_extract(data, '$.status')", enumValues: ['draft', 'sent', 'paid', 'overdue', 'cancelled'] },
		{ key: 'invoiceType', label: 'Type', type: 'enum', column: "json_extract(data, '$.invoiceType')", enumValues: ['invoice', 'creditNote'] },
		{ key: 'clientId', label: 'Client ID', type: 'string', column: "json_extract(data, '$.clientId')" },
		{ key: 'currency', label: 'Currency', type: 'string', column: "json_extract(data, '$.currency')" },
		{ key: 'issueDate', label: 'Issue date', type: 'date', column: "json_extract(data, '$.issueDate')" },
		{ key: 'dueDate', label: 'Due date', type: 'date', column: "json_extract(data, '$.dueDate')" },
		{ key: 'paidDate', label: 'Paid date', type: 'date', column: "json_extract(data, '$.paidDate')" },
		{ key: 'total', label: 'Total (cents)', type: 'number', column: "json_extract(data, '$.totals.total')" },
		{ key: 'sentTo', label: 'Sent to', type: 'string', column: "json_extract(data, '$.sentTo')" },
		{ key: 'createdAt', label: 'Created', type: 'date', column: 'created_at' },
		{ key: 'updatedAt', label: 'Updated', type: 'date', column: 'updated_at' }
	],
	proposal: [
		{ key: 'documentId', label: 'Document ID', type: 'string', column: "json_extract(data, '$.documentId')" },
		{ key: 'status', label: 'Status', type: 'enum', column: "json_extract(data, '$.status')", enumValues: ['draft', 'sent', 'accepted', 'rejected', 'expired'] },
		{ key: 'clientId', label: 'Client ID', type: 'string', column: "json_extract(data, '$.clientId')" },
		{ key: 'issueDate', label: 'Issue date', type: 'date', column: "json_extract(data, '$.issueDate')" },
		{ key: 'validUntil', label: 'Valid until', type: 'date', column: "json_extract(data, '$.validUntil')" },
		{ key: 'total', label: 'Total (cents)', type: 'number', column: "json_extract(data, '$.totals.total')" },
		{ key: 'createdAt', label: 'Created', type: 'date', column: 'created_at' }
	],
	client: [
		{ key: 'name', label: 'Name', type: 'string', column: "json_extract(data, '$.name')" },
		{ key: 'clientNumber', label: 'Client number', type: 'string', column: "json_extract(data, '$.clientNumber')" },
		{ key: 'email', label: 'Email', type: 'string', column: "json_extract(data, '$.email')" },
		{ key: 'language', label: 'Language', type: 'string', column: "json_extract(data, '$.language')" },
		{ key: 'currency', label: 'Currency', type: 'string', column: "json_extract(data, '$.currency')" },
		{ key: 'country', label: 'Country', type: 'string', column: "json_extract(data, '$.address.country')" },
		{ key: 'createdAt', label: 'Created', type: 'date', column: 'created_at' }
	],
	ticket: [
		{ key: 'status', label: 'Status', type: 'enum', column: "json_extract(data, '$.status')", enumValues: ['open', 'completed', 'invoiced'] },
		{ key: 'clientId', label: 'Client ID', type: 'string', column: "json_extract(data, '$.clientId')" },
		{ key: 'date', label: 'Date', type: 'date', column: "json_extract(data, '$.date')" },
		{ key: 'durationMinutes', label: 'Duration (min)', type: 'number', column: "json_extract(data, '$.durationMinutes')" },
		{ key: 'createdAt', label: 'Created', type: 'date', column: 'created_at' }
	],
	expense: [
		{ key: 'category', label: 'Category', type: 'string', column: "json_extract(data, '$.category')" },
		{ key: 'amount', label: 'Amount (cents)', type: 'number', column: "json_extract(data, '$.amount')" },
		{ key: 'date', label: 'Date', type: 'date', column: "json_extract(data, '$.date')" },
		{ key: 'createdAt', label: 'Created', type: 'date', column: 'created_at' }
	]
};

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

export type DocumentFieldType = keyof typeof STATIC_DOCUMENT_FIELDS;

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
		const isAgent = appliesTo === 'agent';
		const column = isAgent
			? `json_extract(data, '$.custom.${parsed.fieldKey}')`
			: `json_extract(data, '$.custom.${parsed.fieldKey}')`;
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

export function buildDocumentFieldRegistry(type: DocumentFieldType): ReadonlyMap<string, FilterFieldDef> {
	const m = new Map<string, FilterFieldDef>();
	for (const f of STATIC_DOCUMENT_FIELDS[type] ?? []) m.set(f.key, f);
	for (const f of readCustomFieldDefs(type)) m.set(f.key, f);
	return m;
}

export function buildAgentFieldRegistry(): ReadonlyMap<string, FilterFieldDef> {
	const m = new Map<string, FilterFieldDef>();
	for (const f of STATIC_AGENT_FIELDS) m.set(f.key, f);
	for (const f of readCustomFieldDefs('agent')) m.set(f.key, f);
	return m;
}

export function listAvailableFilterTypes(): DocumentFieldType[] {
	return Object.keys(STATIC_DOCUMENT_FIELDS) as DocumentFieldType[];
}
