import { describe, it, expect } from 'vitest';
import { compileFilter, operatorsFor, type FilterFieldDef } from '../../src/lib/server/filter-engine.js';

const fields = new Map<string, FilterFieldDef>([
	['status', { key: 'status', label: 'Status', type: 'enum', column: "json_extract(data, '$.status')", enumValues: ['open', 'closed'] }],
	['name', { key: 'name', label: 'Name', type: 'string', column: 'name' }],
	['total', { key: 'total', label: 'Total', type: 'number', column: "json_extract(data, '$.total')" }],
	['createdAt', { key: 'createdAt', label: 'Created', type: 'date', column: 'created_at' }],
	['enabled', { key: 'enabled', label: 'Enabled', type: 'boolean', column: 'enabled' }],
	['tags', { key: 'tags', label: 'Tags', type: 'array', column: 'tags' }]
]);

describe('compileFilter — operator coverage', () => {
	it('eq on string', () => {
		const c = compileFilter([{ field: 'name', operator: 'eq', value: 'foo' }], fields);
		expect(c.sql).toBe('name = ?');
		expect(c.params).toEqual(['foo']);
	});

	it('contains on string with LIKE escapes', () => {
		const c = compileFilter([{ field: 'name', operator: 'contains', value: '50%_off' }], fields);
		expect(c.sql).toContain(`LIKE ? ESCAPE '\\'`);
		expect(c.params).toEqual([`%50\\%\\_off%`]);
	});

	it('in produces N placeholders', () => {
		const c = compileFilter([{ field: 'status', operator: 'in', value: ['open', 'closed'] }], fields);
		expect(c.sql).toBe(`json_extract(data, '$.status') IN (?,?)`);
		expect(c.params).toEqual(['open', 'closed']);
	});

	it('numeric comparison', () => {
		const c = compileFilter([{ field: 'total', operator: 'gte', value: 100 }], fields);
		expect(c.sql).toBe(`json_extract(data, '$.total') >= ?`);
		expect(c.params).toEqual([100]);
	});

	it('date within_last_days', () => {
		const c = compileFilter([{ field: 'createdAt', operator: 'within_last_days', value: 7 }], fields);
		expect(c.sql).toBe(`datetime(created_at) >= datetime('now', ?)`);
		expect(c.params).toEqual(['-7 days']);
	});

	it('boolean eq coerces truthiness', () => {
		const c = compileFilter([{ field: 'enabled', operator: 'eq', value: true }], fields);
		expect(c.params).toEqual([1]);
		const c2 = compileFilter([{ field: 'enabled', operator: 'eq', value: 'true' }], fields);
		expect(c2.params).toEqual([1]);
	});

	it('has_any over JSON array column', () => {
		const c = compileFilter([{ field: 'tags', operator: 'has_any', value: ['prod', 'staging'] }], fields);
		expect(c.sql).toContain('json_each(tags)');
		expect(c.params).toEqual(['prod', 'staging']);
	});

	it('multiple conditions AND-joined', () => {
		const c = compileFilter([
			{ field: 'status', operator: 'eq', value: 'open' },
			{ field: 'total', operator: 'gt', value: 50 }
		], fields);
		expect(c.sql).toBe(`json_extract(data, '$.status') = ? AND json_extract(data, '$.total') > ?`);
		expect(c.params).toEqual(['open', 50]);
	});

	it('empty conditions array compiles to "1" placeholder', () => {
		const c = compileFilter([], fields);
		expect(c.sql).toBe('1');
		expect(c.params).toEqual([]);
	});

	it('is_null / is_not_null take no params', () => {
		const a = compileFilter([{ field: 'status', operator: 'is_null' }], fields);
		expect(a.sql).toContain('IS NULL');
		expect(a.params).toEqual([]);
		const b = compileFilter([{ field: 'status', operator: 'is_not_null' }], fields);
		expect(b.sql).toContain('IS NOT NULL');
	});

	it('neq treats NULL as not-matching', () => {
		const c = compileFilter([{ field: 'status', operator: 'neq', value: 'open' }], fields);
		expect(c.sql).toBe(`(json_extract(data, '$.status') IS NULL OR json_extract(data, '$.status') != ?)`);
	});
});

describe('compileFilter — defenses', () => {
	it('rejects unknown field', () => {
		expect(() => compileFilter([{ field: 'made_up', operator: 'eq', value: 'x' }], fields))
			.toThrow(/unknown field/);
	});

	it('rejects operator/type mismatch', () => {
		expect(() => compileFilter([{ field: 'enabled', operator: 'contains', value: 'x' }], fields))
			.toThrow(/not allowed/);
	});

	it('rejects too many conditions', () => {
		const conds = Array(51).fill({ field: 'name', operator: 'eq', value: 'x' });
		expect(() => compileFilter(conds, fields)).toThrow(/too many/);
	});

	it('rejects non-finite number', () => {
		expect(() => compileFilter([{ field: 'total', operator: 'gt', value: NaN }], fields)).toThrow();
		expect(() => compileFilter([{ field: 'total', operator: 'gt', value: Infinity }], fields)).toThrow();
	});

	it('rejects empty / oversize in arrays', () => {
		expect(() => compileFilter([{ field: 'status', operator: 'in', value: [] }], fields)).toThrow();
		const big = Array(201).fill('x');
		expect(() => compileFilter([{ field: 'status', operator: 'in', value: big }], fields)).toThrow();
	});

	it('within_last_days range bound', () => {
		expect(() => compileFilter([{ field: 'createdAt', operator: 'within_last_days', value: 0 }], fields)).toThrow();
		expect(() => compileFilter([{ field: 'createdAt', operator: 'within_last_days', value: 4000 }], fields)).toThrow();
	});

	it('rejects column with sql comment / semicolon (defensive)', () => {
		const evil = new Map<string, FilterFieldDef>([
			['x', { key: 'x', label: 'X', type: 'string', column: "name; DROP TABLE users--" }]
		]);
		expect(() => compileFilter([{ field: 'x', operator: 'eq', value: 'a' }], evil)).toThrow();
	});
});

describe('operatorsFor by type', () => {
	it('string supports contains', () => {
		expect(operatorsFor('string')).toContain('contains');
	});
	it('boolean is restricted', () => {
		expect([...operatorsFor('boolean')].sort()).toEqual(['eq', 'is_not_null', 'is_null'].sort());
	});
	it('array only supports has_any + null checks', () => {
		expect([...operatorsFor('array')].sort()).toEqual(['has_any', 'is_not_null', 'is_null'].sort());
	});
});
