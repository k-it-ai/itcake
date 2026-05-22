/**
 * Loop-14 follow-ups:
 *   D1 (HIGH) — proposal → invoice conversion preserves the proposal's
 *   `kleinunternehmer` snapshot regardless of the current settings flag.
 *   B4 (MED) — login MFA second-step rate-limit goes through a
 *   separate bucket so wrong-TOTP doesn't lock out password attempts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-loop14');

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'l14.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
});

describe('proposal → invoice conversion preserves kleinunternehmer (D1)', () => {
	it('converted invoice inherits the proposal flag even if settings toggled mid-flow', async () => {
		const { setSetting } = await import('../../src/lib/server/db.js');
		const { createProposal, convertToInvoice, updateProposalStatus } = await import('../../src/services/proposals.js');
		const { createClient } = await import('../../src/services/clients.js');
		const db = (await import('../../src/lib/server/db.js')).db;
		db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash) VALUES ('u-l14', 'u14@t', 'h')`).run();

		// Operator was kleinunternehmer when the proposal was created (no
		// VAT charged). Proposal stored kleinunternehmer=true via createProposal.
		setSetting('advanced', { kleinunternehmer: true, editLock: 'none', sepaQrEnabled: false, auditIntegrityRateLimit: 10 });
		setSetting('invoices', { defaultPaymentTermDays: 30, idFormat: 'INV-{counter}', nextNumber: 1 });
		setSetting('proposals', { defaultValidDays: 30, idFormat: 'PROP-{counter}', nextNumber: 1 });

		const client = createClient({
			clientNumber: '', name: 'Client', email: 'c@t.example', phone: '', website: '',
			vatNumber: '', registrationNumber: '',
			address: { street: '1 St', city: 'B', zip: '10115', state: '', country: 'DE' },
			notes: '', contactPerson: '', language: 'en', currency: 'EUR', paymentTermDays: 30
		}, 'u-l14');

		const proposal = createProposal({
			clientId: client.id,
			pricingMode: 'net',
			currency: 'EUR',
			language: 'en',
			issueDate: '2026-01-01',
			validUntil: '2026-02-01',
			items: [{ id: 'i1', name: 'Service', description: '', quantity: 1, unit: 'h', unitPrice: 10000, taxRate: 19, items: [] }],
			discounts: [],
			notes: '',
			footerText: '',
			templateId: 'kossov-it',
			templateOptions: {}
		}, 'u-l14');
		expect(proposal.kleinunternehmer).toBe(true);

		// Operator marks the proposal sent → ready to convert.
		updateProposalStatus(proposal.id, 'sent', 'u-l14');

		// Operator flips kleinunternehmer OFF before converting.
		setSetting('advanced', { kleinunternehmer: false, editLock: 'none', sepaQrEnabled: false, auditIntegrityRateLimit: 10 });

		const invoice = convertToInvoice(proposal.id, 'u-l14');

		// MUST inherit the proposal's flag, not re-read current settings.
		expect(invoice.kleinunternehmer).toBe(true);
		// Tax rates zeroed because the snapshot says kleinunternehmer.
		expect(invoice.items[0].taxRate).toBe(0);
	});

	it('non-kleinunternehmer proposal stays non-kleinunternehmer when settings switch ON', async () => {
		const { setSetting } = await import('../../src/lib/server/db.js');
		const { createProposal, convertToInvoice, updateProposalStatus } = await import('../../src/services/proposals.js');
		const { createClient } = await import('../../src/services/clients.js');
		const db = (await import('../../src/lib/server/db.js')).db;
		db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash) VALUES ('u-l14b', 'u14b@t', 'h')`).run();

		setSetting('advanced', { kleinunternehmer: false, editLock: 'none', sepaQrEnabled: false, auditIntegrityRateLimit: 10 });

		const client = createClient({
			clientNumber: '', name: 'Client2', email: 'c2@t.example', phone: '', website: '',
			vatNumber: '', registrationNumber: '',
			address: { street: '1 St', city: 'B', zip: '10115', state: '', country: 'DE' },
			notes: '', contactPerson: '', language: 'en', currency: 'EUR', paymentTermDays: 30
		}, 'u-l14b');

		const proposal = createProposal({
			clientId: client.id,
			pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: '2026-01-01', validUntil: '2026-02-01',
			items: [{ id: 'i1', name: 'Service', description: '', quantity: 1, unit: 'h', unitPrice: 10000, taxRate: 19, items: [] }],
			discounts: [], notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		}, 'u-l14b');
		expect(proposal.kleinunternehmer).toBe(false);

		updateProposalStatus(proposal.id, 'sent', 'u-l14b');
		setSetting('advanced', { kleinunternehmer: true, editLock: 'none', sepaQrEnabled: false, auditIntegrityRateLimit: 10 });

		const invoice = convertToInvoice(proposal.id, 'u-l14b');
		expect(invoice.kleinunternehmer).toBe(false);
		expect(invoice.items[0].taxRate).toBe(19);
	});
});

describe('login MFA second-step rate-limit isolation (B4)', () => {
	it('checkAndRecordLoginStep2Attempt bumps global + ip but NOT email', async () => {
		const { checkAndRecordLoginStep2Attempt } = await import('../../src/lib/server/rate-limit.js');
		const db = (await import('../../src/lib/server/db.js')).db;
		// Wipe relevant rate-limit rows.
		db.prepare(`DELETE FROM rate_limits WHERE key IN ('login_global', 'ip:9.9.9.9', 'email:l14@b.example')`).run();

		checkAndRecordLoginStep2Attempt('9.9.9.9');

		const ipRow = db.prepare(`SELECT count FROM rate_limits WHERE key='ip:9.9.9.9'`).get() as { count: number };
		const emailRow = db.prepare(`SELECT count FROM rate_limits WHERE key='email:l14@b.example'`).get();
		expect(ipRow?.count).toBe(1);
		expect(emailRow).toBeUndefined();
	});

	it('three step-2 attempts do NOT exhaust the per-email bucket', async () => {
		const { checkAndRecordLoginStep2Attempt, checkAndRecordLoginAttempt } = await import('../../src/lib/server/rate-limit.js');
		const db = (await import('../../src/lib/server/db.js')).db;
		db.prepare(`DELETE FROM rate_limits WHERE key IN ('login_global', 'ip:8.8.8.8', 'email:l14c@b.example')`).run();

		// 3x wrong TOTP — all step-2 — none of which touch the email bucket.
		checkAndRecordLoginStep2Attempt('8.8.8.8');
		checkAndRecordLoginStep2Attempt('8.8.8.8');
		checkAndRecordLoginStep2Attempt('8.8.8.8');

		// Now a legitimate password retry should succeed (email bucket fresh).
		expect(() => checkAndRecordLoginAttempt('8.8.8.8', 'l14c@b.example')).not.toThrow();
	});
});
