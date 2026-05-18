/**
 * Regression: validateBackupData previously accepted any counter value in
 * range [0, 9_999_999] without cross-checking against the documents the
 * counter sequences. A backup whose `invoice_global` counter sat below the
 * highest existing invoice's documentId (or below the invoice count) would
 * restore cleanly, then the very next auto-generated invoice would collide
 * with an existing row on documentId. This test pins the shape of the new
 * cross-check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('backups.ts: counter-vs-document cross-check on restore', () => {
	const src = readFileSync(path.resolve('src/services/backups.ts'), 'utf-8');

	it('builds a counter-to-document-type map and checks each', () => {
		expect(src).toMatch(/counterToDocType[^=]*=\s*\{[^}]*invoice_global:\s*'invoice'/);
		expect(src).toMatch(/proposal_global:\s*'proposal'/);
		expect(src).toMatch(/client_global:\s*'client'/);
		expect(src).toMatch(/ticket_global:\s*'ticket'/);
	});

	it('rejects with a precise error mentioning counter, value, and max', () => {
		expect(src).toMatch(/Invalid backup: counter "\$\{key\}" value \$\{cv\} is lower than the highest existing \$\{docType\} \(max=\$\{needed\}\)/);
	});

	it('compares against both document count and max-trailing-digit', () => {
		expect(src).toMatch(/Math\.max\(docCount, maxTrailing\)/);
		expect(src).toMatch(/match\(\/\(\\d\+\)\\D\*\$\/\)/);
	});
});
