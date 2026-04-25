import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { pickPresentKeys } from '../../src/lib/server/request-utils.js';

// Zod 4's `.partial()` keeps `.default()` values, which means a PATCH-shaped
// payload would otherwise overwrite every other field with its schema default.
// pickPresentKeys is the workaround that re-narrows the parsed result to only
// the keys the caller actually sent.

describe('pickPresentKeys', () => {
	it('keeps only keys present in the original input', () => {
		const schema = z.object({
			notes: z.string().default(''),
			templateId: z.string().default('plain'),
			status: z.enum(['draft', 'sent']).default('draft')
		}).partial();
		const input = { notes: 'hi' };
		const parsed = schema.parse(input);
		// Sanity: Zod 4 fills in the defaults — this is the bug we're guarding against.
		expect(parsed).toMatchObject({ notes: 'hi', templateId: 'plain', status: 'draft' });
		const safe = pickPresentKeys(parsed, input);
		expect(safe).toEqual({ notes: 'hi' });
	});

	it('drops parsed keys that the input never declared', () => {
		const safe = pickPresentKeys({ a: 1, b: 2, c: 3 }, { a: 1, c: 999 });
		expect(safe).toEqual({ a: 1, c: 3 });
	});

	it('does not propagate keys whose validation produced undefined', () => {
		const schema = z.object({
			optional: z.string().optional(),
			required: z.string().default('x')
		}).partial();
		const input = { optional: undefined, required: 'real' } as Record<string, unknown>;
		const parsed = schema.parse(input);
		const safe = pickPresentKeys(parsed, input);
		// `optional` was declared but parsed to undefined, so it isn't in `parsed`
		// and therefore must not be in the safe output either.
		expect(safe).toEqual({ required: 'real' });
	});

	it('returns an empty object when input has no schema-known keys', () => {
		const safe = pickPresentKeys({ a: 1 }, { foreign: 'value' });
		expect(safe).toEqual({});
	});
});
