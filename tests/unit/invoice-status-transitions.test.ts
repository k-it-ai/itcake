/**
 * `VALID_TRANSITIONS` for invoices is the business-rule gate that
 * prevents an operator from moving an invoice through a forbidden
 * sequence (e.g., `cancelled → paid` without going back to `draft`
 * first). The gate is enforced via `validateTransition` from
 * `document-helpers.ts`.
 *
 * Previously only indirectly covered by the lifecycle test. These
 * cases pin every cell of the transition matrix so a future edit
 * that widens the rules surfaces in CI.
 */
import { describe, it, expect } from 'vitest';
import { ServiceError } from '../../src/lib/server/service-error.js';
import { validateTransition } from '../../src/services/document-helpers.js';
import { VALID_TRANSITIONS } from '../../src/services/invoices.js';
import type { InvoiceStatus } from '../../src/lib/types.js';

function assertOk(from: InvoiceStatus, to: InvoiceStatus) {
	expect(() => validateTransition(VALID_TRANSITIONS, from, to)).not.toThrow();
}

function assertRejects(from: InvoiceStatus, to: InvoiceStatus) {
	try {
		validateTransition(VALID_TRANSITIONS, from, to);
		expect.fail(`expected ${from} → ${to} to be rejected`);
	} catch (e) {
		expect(e).toBeInstanceOf(ServiceError);
		if (e instanceof ServiceError) {
			expect(e.i18nKey).toBe('error.invalidStatusTransition');
		}
	}
}

describe('Invoice status transition matrix (VALID_TRANSITIONS)', () => {
	it('draft → sent allowed', () => assertOk('draft', 'sent'));
	it('draft → cancelled allowed', () => assertOk('draft', 'cancelled'));
	it('draft → paid REJECTED (must go via sent)', () => assertRejects('draft', 'paid'));
	it('draft → overdue REJECTED', () => assertRejects('draft', 'overdue'));

	it('sent → paid allowed', () => assertOk('sent', 'paid'));
	it('sent → overdue allowed', () => assertOk('sent', 'overdue'));
	it('sent → cancelled allowed', () => assertOk('sent', 'cancelled'));
	it('sent → draft REJECTED (one-way after send)', () => assertRejects('sent', 'draft'));

	it('overdue → paid allowed', () => assertOk('overdue', 'paid'));
	it('overdue → sent allowed (operator can re-send overdue)', () => assertOk('overdue', 'sent'));
	it('overdue → cancelled allowed', () => assertOk('overdue', 'cancelled'));
	it('overdue → draft REJECTED', () => assertRejects('overdue', 'draft'));

	it('paid → sent allowed (operator can revert payment-marking by mistake)', () => assertOk('paid', 'sent'));
	it('paid → draft REJECTED (no destructive reverts)', () => assertRejects('paid', 'draft'));
	it('paid → cancelled REJECTED (must un-pay first via sent)', () => assertRejects('paid', 'cancelled'));
	it('paid → overdue REJECTED', () => assertRejects('paid', 'overdue'));

	it('cancelled → draft allowed (re-open from cancelled)', () => assertOk('cancelled', 'draft'));
	it('cancelled → sent REJECTED (must re-open as draft first)', () => assertRejects('cancelled', 'sent'));
	it('cancelled → paid REJECTED', () => assertRejects('cancelled', 'paid'));
	it('cancelled → overdue REJECTED', () => assertRejects('cancelled', 'overdue'));

	it('self-transition is always rejected (never a no-op)', () => {
		for (const s of ['draft', 'sent', 'overdue', 'paid', 'cancelled'] as const) {
			assertRejects(s, s);
		}
	});

	it('validateTransition on an empty allowed list rejects everything', () => {
		const empty: Record<string, string[]> = { foo: [] };
		expect(() => validateTransition(empty, 'foo', 'bar')).toThrow();
	});

	it('validateTransition on an unknown current-status rejects', () => {
		// `unknown` not in the map → allowed = undefined → [] → reject.
		expect(() => validateTransition({} as Record<string, string[]>, 'unknown' as never, 'draft' as never)).toThrow();
	});
});
