import { db, generateId, insertDocument, updateDocument, deleteDocument, getDocument } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { ServiceError } from '$lib/server/service-error.js';
import { EXTENSIBLE_ENTITY_TYPES, type ExtensibleEntityType } from '$lib/types.js';
import { z } from 'zod';

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

export const customFieldDefSchema = z.object({
	name: z.string().min(1).max(100),
	fieldKey: z.string().regex(FIELD_KEY_RE, 'fieldKey must match ^[a-z][a-z0-9_]{0,31}$'),
	type: z.enum(['text', 'number', 'boolean', 'date', 'enum']),
	enumValues: z.array(z.string().min(1).max(100)).max(50).optional(),
	appliesTo: z.array(z.enum(EXTENSIBLE_ENTITY_TYPES)).min(1).max(EXTENSIBLE_ENTITY_TYPES.length),
	required: z.boolean().default(false)
}).superRefine((d, ctx) => {
	if (d.type === 'enum' && (!d.enumValues || d.enumValues.length === 0)) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'enumValues required when type=enum', path: ['enumValues'] });
	}
});

export type CustomFieldDef = z.infer<typeof customFieldDefSchema> & {
	id: string;
	createdAt: string;
	updatedAt: string;
};

interface DocRow { id: string; data: string; created_at: string; updated_at: string }

const stmtList = db.prepare(
	"SELECT id, data, created_at, updated_at FROM documents WHERE type = 'custom_field_def' ORDER BY created_at ASC"
);

function rowToDef(r: DocRow): CustomFieldDef {
	const parsed = JSON.parse(r.data);
	return { ...parsed, id: r.id, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listCustomFields(appliesTo?: string): CustomFieldDef[] {
	const all = (stmtList.all() as DocRow[]).map(rowToDef);
	return appliesTo ? all.filter(d => d.appliesTo.includes(appliesTo as ExtensibleEntityType)) : all;
}

export function getCustomField(id: string): CustomFieldDef | null {
	const data = getDocument<unknown>(id, 'custom_field_def');
	if (!data) return null;
	const row = db.prepare('SELECT created_at, updated_at FROM documents WHERE id = ?').get(id) as { created_at: string; updated_at: string } | undefined;
	if (!row) return null;
	return { ...(data as object), id, createdAt: row.created_at, updatedAt: row.updated_at } as CustomFieldDef;
}

function ensureFieldKeyUnique(fieldKey: string, ignoreId?: string): void {
	const all = listCustomFields();
	if (all.some(d => d.fieldKey === fieldKey && d.id !== ignoreId)) {
		throw new ServiceError('error.customFieldKeyExists', { fieldKey });
	}
}

export function createCustomField(input: z.input<typeof customFieldDefSchema>, userId: string): CustomFieldDef {
	const parsed = customFieldDefSchema.parse(input);
	ensureFieldKeyUnique(parsed.fieldKey);
	const id = generateId();
	const data = { ...parsed };
	db.transaction(() => {
		insertDocument(id, 'custom_field_def', data);
		recordChange('custom_field_def', id, 'create', { fieldKey: { old: null, new: parsed.fieldKey } }, userId);
	})();
	return getCustomField(id)!;
}

export function updateCustomField(id: string, input: z.input<typeof customFieldDefSchema>, userId: string): CustomFieldDef | null {
	const existing = getCustomField(id);
	if (!existing) return null;
	const parsed = customFieldDefSchema.parse(input);
	// fieldKey is immutable post-create. Renaming would orphan stored values.
	if (parsed.fieldKey !== existing.fieldKey) {
		throw new ServiceError('error.customFieldKeyImmutable');
	}
	db.transaction(() => {
		updateDocument(id, parsed);
		recordChange('custom_field_def', id, 'update', { name: { old: existing.name, new: parsed.name } }, userId);
	})();
	return getCustomField(id);
}

export function deleteCustomField(id: string, userId: string): boolean {
	const existing = getCustomField(id);
	if (!existing) return false;
	db.transaction(() => {
		deleteDocument(id);
		recordChange('custom_field_def', id, 'delete', { fieldKey: { old: existing.fieldKey, new: null } }, userId);
	})();
	return true;
}
