import { db, generateId, insertDocument, updateDocument, deleteDocument, getDocument } from '#lib/server/db.js';
import { recordChange } from '#lib/server/changes.js';
import { ServiceError } from '#lib/server/service-error.js';
import { EXTENSIBLE_ENTITY_TYPES } from '#lib/types.js';
import { z } from 'zod';

const FILTER_OPERATORS = [
	'eq', 'neq', 'contains', 'starts_with', 'ends_with',
	'in', 'not_in', 'lt', 'lte', 'gt', 'gte',
	'before', 'after', 'within_last_minutes', 'within_last_days',
	'is_null', 'is_not_null', 'has_any'
] as const;

const filterConditionSchema = z.object({
	field: z.string().min(1).max(100).regex(/^[a-zA-Z][a-zA-Z0-9_.]*$/),
	operator: z.enum(FILTER_OPERATORS),
	value: z.unknown().optional()
}).strict();

const savedFilterSchema = z.object({
	name: z.string().min(1).max(100),
	appliesTo: z.enum(EXTENSIBLE_ENTITY_TYPES),
	conditions: z.array(filterConditionSchema).max(50),
	orderBy: z.enum(['created_at DESC', 'created_at ASC', 'updated_at DESC', 'updated_at ASC']).default('created_at DESC')
});

export type SavedFilter = z.infer<typeof savedFilterSchema> & {
	id: string;
	createdAt: string;
	updatedAt: string;
};

interface DocRow { id: string; data: string; created_at: string; updated_at: string }

const stmtList = db.prepare(
	"SELECT id, data, created_at, updated_at FROM documents WHERE type = 'saved_filter' ORDER BY json_extract(data, '$.name') ASC"
);

function rowToFilter(r: DocRow): SavedFilter {
	const parsed = JSON.parse(r.data);
	return { ...parsed, id: r.id, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listSavedFilters(appliesTo?: string): SavedFilter[] {
	const all = (stmtList.all() as DocRow[]).map(rowToFilter);
	return appliesTo ? all.filter(f => f.appliesTo === appliesTo) : all;
}

export function getSavedFilter(id: string): SavedFilter | null {
	const data = getDocument<unknown>(id, 'saved_filter');
	if (!data) return null;
	const row = db.prepare('SELECT created_at, updated_at FROM documents WHERE id = ?').get(id) as { created_at: string; updated_at: string } | undefined;
	if (!row) return null;
	return { ...(data as object), id, createdAt: row.created_at, updatedAt: row.updated_at } as SavedFilter;
}

export function createSavedFilter(input: z.input<typeof savedFilterSchema>, userId: string): SavedFilter {
	const parsed = savedFilterSchema.parse(input);
	const id = generateId();
	db.transaction(() => {
		insertDocument(id, 'saved_filter', parsed);
		recordChange('saved_filter', id, 'create', { name: { old: null, new: parsed.name } }, userId);
	})();
	return getSavedFilter(id)!;
}

export function updateSavedFilter(id: string, input: z.input<typeof savedFilterSchema>, userId: string): SavedFilter | null {
	const existing = getSavedFilter(id);
	if (!existing) return null;
	const parsed = savedFilterSchema.parse(input);
	if (parsed.appliesTo !== existing.appliesTo) {
		throw new ServiceError('error.savedFilterAppliesToImmutable');
	}
	db.transaction(() => {
		updateDocument(id, parsed);
		recordChange('saved_filter', id, 'update', { name: { old: existing.name, new: parsed.name } }, userId);
	})();
	return getSavedFilter(id);
}

export function deleteSavedFilter(id: string, userId: string): boolean {
	const existing = getSavedFilter(id);
	if (!existing) return false;
	db.transaction(() => {
		deleteDocument(id);
		recordChange('saved_filter', id, 'delete', { name: { old: existing.name, new: null } }, userId);
	})();
	return true;
}
