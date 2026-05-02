import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// pickPresentKeys is the workaround that re-narrows the parsed result to only
const TEST_DIR = path.resolve('data-test-pick-present-keys');

let pickPresentKeys: typeof import('../../src/lib/server/request-utils.js').pickPresentKeys;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'pick.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const m = await import('../../src/lib/server/request-utils.js');
	pickPresentKeys = m.pickPresentKeys;
});

describe('pickPresentKeys', () => {
	it('keeps only keys present in the original input', () => {
		const schema = z.object({
			notes: z.string().default(''),
			templateId: z.string().default('plain'),
			status: z.enum(['draft', 'sent']).default('draft')
		}).partial();
		const input = { notes: 'hi' };
		const parsed = schema.parse(input);
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
		// and therefore must not be in the safe output either.
		expect(safe).toEqual({ required: 'real' });
	});

	it('returns an empty object when input has no schema-known keys', () => {
		const safe = pickPresentKeys({ a: 1 }, { foreign: 'value' });
		expect(safe).toEqual({});
	});
});
