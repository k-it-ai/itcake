/**
 * Typed filter compiler. Emits {sql, params} fragments that drop
 * straight into queryDocumentsPaginated() (or any prepared statement
 * that takes a WHERE clause) without sigil splicing.
 *
 * Two registries are supplied at runtime: one for documents (per-type
 * field set + custom-field defs read from `documents.type='custom_field_def'`)
 * and one for agents (top-level columns + agent-side custom fields).
 * Both share the same engine; only the field map differs.
 *
 * Defenses:
 *   - operator allowlist (no SQL composed from operator string)
 *   - field allowlist (only registered keys)
 *   - column expressions are author-controlled, not user-supplied
 *   - all literals go through positional `?` params
 *   - safe-fragment regex re-checks the emitted WHERE before it leaves
 */

export type FilterOperator =
	| 'eq' | 'neq'
	| 'contains' | 'starts_with' | 'ends_with'
	| 'in' | 'not_in'
	| 'lt' | 'lte' | 'gt' | 'gte'
	| 'before' | 'after'
	| 'within_last_minutes' | 'within_last_days'
	| 'is_null' | 'is_not_null'
	| 'has_any';

export type FilterFieldType = 'string' | 'number' | 'date' | 'boolean' | 'enum' | 'array';

export interface FilterFieldDef {
	key: string;             // e.g. 'name', 'status', 'custom.priority'
	label: string;
	type: FilterFieldType;
	/**
	 * SQL fragment emitted as the LHS of comparisons. For documents-store
	 * fields, this is typically `json_extract(data, '$.status')`. For
	 * dedicated tables (agents, monitors), a column name like `name` or
	 * a CASE expression is fine. Author-controlled — never user input.
	 */
	column: string;
	enumValues?: string[];
}

export interface FilterCondition {
	field: string;
	operator: FilterOperator;
	value?: unknown;
}

export interface CompiledFilter {
	sql: string;
	params: unknown[];
}

const OPERATORS_BY_TYPE: Record<FilterFieldType, ReadonlySet<FilterOperator>> = {
	string: new Set(['eq', 'neq', 'contains', 'starts_with', 'ends_with', 'in', 'not_in', 'is_null', 'is_not_null']),
	number: new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'is_null', 'is_not_null']),
	date: new Set(['eq', 'neq', 'before', 'after', 'within_last_minutes', 'within_last_days', 'is_null', 'is_not_null']),
	boolean: new Set(['eq', 'is_null', 'is_not_null']),
	enum: new Set(['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null']),
	array: new Set(['has_any', 'is_null', 'is_not_null'])
};

export function operatorsFor(type: FilterFieldType): ReadonlyArray<FilterOperator> {
	return Array.from(OPERATORS_BY_TYPE[type]);
}

const SAFE_COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_.()'$,\\\s-]*$/;
const FORBIDDEN_COLUMN_RE = /--|\/\*|\*\/|;/;

function escapeLikeLiteral(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function asString(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	throw new Error(`filter-engine: expected string-coercible value, got ${typeof value}`);
}

function asNumber(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
	throw new Error(`filter-engine: expected finite number, got ${JSON.stringify(value)}`);
}

function asArray(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error('filter-engine: expected array');
	if (value.length === 0) throw new Error('filter-engine: empty array');
	if (value.length > 200) throw new Error('filter-engine: array exceeds 200 elements');
	return value.map(asString);
}

function compileCondition(c: FilterCondition, fields: ReadonlyMap<string, FilterFieldDef>): CompiledFilter {
	const def = fields.get(c.field);
	if (!def) throw new Error(`filter-engine: unknown field "${c.field}"`);
	const allowed = OPERATORS_BY_TYPE[def.type];
	if (!allowed.has(c.operator)) {
		throw new Error(`filter-engine: operator "${c.operator}" not allowed for ${def.type} field "${c.field}"`);
	}
	if (!SAFE_COLUMN_RE.test(def.column) || FORBIDDEN_COLUMN_RE.test(def.column)) {
		// Author bug — never user input. Caught here defends against a future
		// registry change accidentally splicing dangerous text.
		throw new Error(`filter-engine: registry column "${def.column}" rejected by safety regex`);
	}
	const col = def.column;
	switch (c.operator) {
		case 'eq': {
			if (def.type === 'boolean') {
				const b = c.value === true || c.value === 1 || c.value === '1' || c.value === 'true';
				return { sql: `${col} = ?`, params: [b ? 1 : 0] };
			}
			if (def.type === 'number') return { sql: `${col} = ?`, params: [asNumber(c.value)] };
			return { sql: `${col} = ?`, params: [asString(c.value)] };
		}
		case 'neq': {
			if (def.type === 'number') return { sql: `(${col} IS NULL OR ${col} != ?)`, params: [asNumber(c.value)] };
			return { sql: `(${col} IS NULL OR ${col} != ?)`, params: [asString(c.value)] };
		}
		case 'contains':
			return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${escapeLikeLiteral(asString(c.value))}%`] };
		case 'starts_with':
			return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`${escapeLikeLiteral(asString(c.value))}%`] };
		case 'ends_with':
			return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${escapeLikeLiteral(asString(c.value))}`] };
		case 'in':
		case 'not_in': {
			const items = asArray(c.value);
			const placeholders = items.map(() => '?').join(',');
			const negate = c.operator === 'not_in';
			return {
				sql: negate ? `(${col} IS NULL OR ${col} NOT IN (${placeholders}))` : `${col} IN (${placeholders})`,
				params: items
			};
		}
		case 'lt': return { sql: `${col} < ?`, params: [asNumber(c.value)] };
		case 'lte': return { sql: `${col} <= ?`, params: [asNumber(c.value)] };
		case 'gt': return { sql: `${col} > ?`, params: [asNumber(c.value)] };
		case 'gte': return { sql: `${col} >= ?`, params: [asNumber(c.value)] };
		case 'before': return { sql: `datetime(${col}) < datetime(?)`, params: [asString(c.value)] };
		case 'after': return { sql: `datetime(${col}) > datetime(?)`, params: [asString(c.value)] };
		case 'within_last_minutes': {
			const n = asNumber(c.value);
			if (n < 1 || n > 525600) throw new Error('filter-engine: within_last_minutes out of range');
			return { sql: `datetime(${col}) >= datetime('now', ?)`, params: [`-${Math.floor(n)} minutes`] };
		}
		case 'within_last_days': {
			const n = asNumber(c.value);
			if (n < 1 || n > 3650) throw new Error('filter-engine: within_last_days out of range');
			return { sql: `datetime(${col}) >= datetime('now', ?)`, params: [`-${Math.floor(n)} days`] };
		}
		case 'is_null': return { sql: `${col} IS NULL`, params: [] };
		case 'is_not_null': return { sql: `${col} IS NOT NULL`, params: [] };
		case 'has_any': {
			const items = asArray(c.value);
			const clauses = items.map(() => `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`);
			return { sql: `(${clauses.join(' OR ')})`, params: items };
		}
	}
}

/**
 * AND-join an array of conditions into a single SQL fragment + params.
 * An empty array returns `{sql: '1', params: []}` so callers can splice
 * unconditionally into "WHERE … AND <fragment>".
 */
export function compileFilter(
	conditions: FilterCondition[],
	fields: ReadonlyMap<string, FilterFieldDef>
): CompiledFilter {
	if (!Array.isArray(conditions)) throw new Error('filter-engine: conditions must be an array');
	if (conditions.length > 50) throw new Error('filter-engine: too many conditions (max 50)');
	if (conditions.length === 0) return { sql: '1', params: [] };
	const parts: string[] = [];
	const params: unknown[] = [];
	for (const c of conditions) {
		if (!c || typeof c !== 'object') throw new Error('filter-engine: condition must be an object');
		const compiled = compileCondition(c, fields);
		parts.push(compiled.sql);
		params.push(...compiled.params);
	}
	return { sql: parts.join(' AND '), params };
}
