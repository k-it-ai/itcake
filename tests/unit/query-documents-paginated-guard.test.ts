import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-qdp-guard');

let queryDocumentsPaginated: typeof import('../../src/lib/server/db.js').queryDocumentsPaginated;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'qdp.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	queryDocumentsPaginated = (await import('../../src/lib/server/db.js')).queryDocumentsPaginated;
});

describe('queryDocumentsPaginated SQL fragment guard (L11 regression)', () => {
	it('accepts the standard json_extract patterns the services use', () => {
		expect(() => queryDocumentsPaginated('client', {
			filters: [
				{ sql: "json_extract(data, '$.name') = ?", params: ['x'] },
				{ sql: "(json_extract(data, '$.name') LIKE ? ESCAPE '\\' OR json_extract(data, '$.email') LIKE ? ESCAPE '\\')", params: ['%a%', '%a%'] },
				{ sql: "json_extract(data, '$.date') >= ?", params: ['2026-01-01'] },
				{ sql: "json_extract(data, '$.amount') <= ?", params: [1000] }
			]
		})).not.toThrow();
	});

	it('rejects SQL comments (--, /* ... */)', () => {
		expect(() => queryDocumentsPaginated('client', {
			filters: [{ sql: "json_extract(data, '$.name') = ? -- AND admin = 1", params: ['x'] }]
		})).toThrow(/unsafe SQL fragment/);
		expect(() => queryDocumentsPaginated('client', {
			filters: [{ sql: "json_extract(data, '$.name') = ? /* dropped */ ", params: ['x'] }]
		})).toThrow(/unsafe SQL fragment/);
	});

	it('rejects statement separators (semicolons)', () => {
		expect(() => queryDocumentsPaginated('client', {
			filters: [{ sql: "json_extract(data, '$.name') = ?; DROP TABLE clients", params: ['x'] }]
		})).toThrow(/unsafe SQL fragment/);
	});

	it('rejects fragments with placeholder/param count mismatch', () => {
		expect(() => queryDocumentsPaginated('client', {
			filters: [{ sql: "json_extract(data, '$.name') = ?", params: ['x', 'y'] }]
		})).toThrow(/placeholder\/param count mismatch/);
		expect(() => queryDocumentsPaginated('client', {
			filters: [{ sql: "json_extract(data, '$.name') = ? AND json_extract(data, '$.email') = ?", params: ['x'] }]
		})).toThrow(/placeholder\/param count mismatch/);
	});

	it('rejects fragments with disallowed characters', () => {
		expect(() => queryDocumentsPaginated('client', {
			filters: [{ sql: "json_extract(data, '$.name') = ? @ admin", params: ['x'] }]
		})).toThrow(/unsafe SQL fragment/);
	});
});
