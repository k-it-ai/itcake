/**
 * Mirrored amounts must round symmetrically: `Math.round()` biases halves
 * towards +∞, so round(-4999.5) = -4999 while round(4999.5) = 5000 — a
 * one-cent drift between an invoice line and its credit note.
 */
import { describe, it, expect } from 'vitest';
import { computeItemSubtotal } from '../../src/lib/money.js';
import type { LineItem } from '../../src/lib/types.js';

function item(quantity: number, unitPrice = 3333): LineItem {
	return { description: 'line', quantity, unitPrice } as unknown as LineItem;
}

describe('computeItemSubtotal — half-away-from-zero rounding', () => {
	it('rounds .5 half-cents away from zero in both directions', () => {
		expect(computeItemSubtotal(item(1.5))).toBe(5000);
		expect(computeItemSubtotal(item(-1.5))).toBe(-5000);
	});

	it('invoice and mirrored credit-note lines stay exact negatives', () => {
		const lines = [item(1.5, 3333), item(0.5, 9999), item(2.25, 1299)];
		const sum = lines.reduce((s, l) => s + computeItemSubtotal(l), 0);
		const mirrored = lines.reduce((s, l) => s + computeItemSubtotal(item(-l.quantity, l.unitPrice)), 0);
		expect(sum).not.toBe(0);
		expect(mirrored).toBe(-sum);
	});

	it('recurses into nested items symmetrically', () => {
		const group = { description: 'group', quantity: 1, unitPrice: 0, items: [item(1.5)] } as unknown as LineItem;
		const negativeGroup = {
			description: 'group', quantity: 1, unitPrice: 0, items: [item(-1.5)]
		} as unknown as LineItem;
		expect(computeItemSubtotal(group)).toBe(5000);
		expect(computeItemSubtotal(negativeGroup)).toBe(-5000);
	});
});
