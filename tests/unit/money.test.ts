import { describe, it, expect } from 'vitest';
import { computeInvoiceTotals, computeItemSubtotal } from '../../src/lib/money.js';
import type { LineItem, Discount } from '../../src/lib/types.js';

function item(overrides: Partial<LineItem> = {}): LineItem {
	return { id: '1', name: '', description: '', quantity: 1, unit: '', unitPrice: 10000, taxRate: 19, items: [], ...overrides };
}

describe('computeItemSubtotal', () => {
	it('computes quantity * unitPrice for leaf items', () => {
		expect(computeItemSubtotal(item({ quantity: 2, unitPrice: 5000 }))).toBe(10000);
	});

	it('sums sub-item subtotals for parent items', () => {
		const parent = item({
			quantity: 1, unitPrice: 9999, // ignored when sub-items exist
			items: [
				item({ quantity: 2, unitPrice: 3000 }),
				item({ quantity: 1, unitPrice: 4000 })
			]
		});
		expect(computeItemSubtotal(parent)).toBe(10000); // 6000 + 4000
	});

	it('handles negative quantities (credit notes)', () => {
		expect(computeItemSubtotal(item({ quantity: -3, unitPrice: 1000 }))).toBe(-3000);
	});

	it('rounds fractional results', () => {
		expect(computeItemSubtotal(item({ quantity: 0.33, unitPrice: 10000 }))).toBe(3300);
	});

	it('handles deeply nested items (depth cap)', () => {
		let current = item({ quantity: 1, unitPrice: 500 });
		for (let i = 0; i < 15; i++) {
			current = item({ items: [current] });
		}
		expect(computeItemSubtotal(current)).toBe(0);
	});
});

describe('computeInvoiceTotals', () => {
	it('computes correct NET totals', () => {
		const items = [item({ quantity: 10, unitPrice: 7500, taxRate: 19 })];
		const result = computeInvoiceTotals(items, [], 'net');
		expect(result.subtotal).toBe(75000);
		expect(result.discountAmount).toBe(0);
		expect(result.subtotalAfterDiscounts).toBe(75000);
		expect(result.totalTaxes).toBe(14250); // 75000 * 0.19
		expect(result.total).toBe(89250);
		expect(result.netTotal).toBe(75000);
	});

	it('computes correct GROSS totals', () => {
		const items = [item({ quantity: 1, unitPrice: 11900, taxRate: 19 })];
		const result = computeInvoiceTotals(items, [], 'gross');
		expect(result.subtotal).toBe(11900);
		expect(result.total).toBe(11900); // gross: taxes included
		expect(result.totalTaxes).toBe(1900); // 11900 - 10000
		expect(result.netTotal).toBe(10000);
	});

	it('applies percentage discount correctly', () => {
		const items = [item({ quantity: 1, unitPrice: 10000, taxRate: 19 })];
		const discounts: Discount[] = [{ type: 'percentage', value: 10, description: '' }];
		const result = computeInvoiceTotals(items, discounts, 'net');
		expect(result.subtotal).toBe(10000);
		expect(result.discountAmount).toBe(1000);
		expect(result.subtotalAfterDiscounts).toBe(9000);
		expect(result.totalTaxes).toBe(1710); // 9000 * 0.19
		expect(result.total).toBe(10710);
	});

	it('applies fixed discount correctly', () => {
		const items = [item({ quantity: 1, unitPrice: 10000, taxRate: 19 })];
		const discounts: Discount[] = [{ type: 'fixed', value: 2000, description: '' }];
		const result = computeInvoiceTotals(items, discounts, 'net');
		expect(result.discountAmount).toBe(2000);
		expect(result.subtotalAfterDiscounts).toBe(8000);
	});

	it('caps discount at subtotal', () => {
		const items = [item({ quantity: 1, unitPrice: 1000, taxRate: 19 })];
		const discounts: Discount[] = [{ type: 'fixed', value: 5000, description: '' }];
		const result = computeInvoiceTotals(items, discounts, 'net');
		expect(result.subtotalAfterDiscounts).toBe(0);
		expect(result.total).toBe(0);
	});

	it('handles multiple tax rates', () => {
		const items = [
			item({ quantity: 1, unitPrice: 10000, taxRate: 19 }),
			item({ quantity: 1, unitPrice: 10000, taxRate: 7 })
		];
		const result = computeInvoiceTotals(items, [], 'net');
		expect(result.subtotal).toBe(20000);
		expect(result.taxSubtotals).toHaveLength(2);
		expect(result.taxSubtotals[0]).toEqual({ rate: 7, taxableAmount: 10000, taxAmount: 700 });
		expect(result.taxSubtotals[1]).toEqual({ rate: 19, taxableAmount: 10000, taxAmount: 1900 });
		expect(result.totalTaxes).toBe(2600);
	});

	it('filters 0% tax groups from display', () => {
		const items = [
			item({ quantity: 1, unitPrice: 10000, taxRate: 0 }),
			item({ quantity: 1, unitPrice: 10000, taxRate: 19 })
		];
		const result = computeInvoiceTotals(items, [], 'net');
		expect(result.taxSubtotals).toHaveLength(1);
		expect(result.taxSubtotals[0].rate).toBe(19);
	});

	it('handles credit note (negative quantities)', () => {
		const items = [item({ quantity: -2, unitPrice: 5000, taxRate: 19 })];
		const result = computeInvoiceTotals(items, [], 'net');
		expect(result.subtotal).toBe(-10000);
		expect(result.total).toBe(-11900);
		expect(result.totalTaxes).toBe(-1900);
	});

	it('handles empty items', () => {
		const result = computeInvoiceTotals([], [], 'net');
		expect(result.subtotal).toBe(0);
		expect(result.total).toBe(0);
	});

	it('distributes discount proportionally across tax groups', () => {
		const items = [
			item({ quantity: 1, unitPrice: 20000, taxRate: 19 }), // 200€
			item({ quantity: 1, unitPrice: 10000, taxRate: 7 })   // 100€
		];
		const discounts: Discount[] = [{ type: 'percentage', value: 10, description: '' }];
		const result = computeInvoiceTotals(items, discounts, 'net');
		expect(result.taxSubtotals[0]).toEqual({ rate: 7, taxableAmount: 9000, taxAmount: 630 });
		expect(result.taxSubtotals[1]).toEqual({ rate: 19, taxableAmount: 18000, taxAmount: 3420 });
	});

	it('reconciles rounding remainder when discounts span multiple tax groups (DATA-001)', () => {
		const items = [
			item({ quantity: 1, unitPrice: 3333, taxRate: 19 }),
			item({ quantity: 1, unitPrice: 3333, taxRate: 7 }),
			item({ quantity: 1, unitPrice: 3334, taxRate: 5 })
		];
		const discounts: Discount[] = [{ type: 'fixed', value: 1000, description: '' }];
		const result = computeInvoiceTotals(items, discounts, 'net');
		// Sum of taxable amounts must exactly equal subtotalAfterDiscounts
		const taxableSum = result.taxSubtotals.reduce((s, ts) => s + ts.taxableAmount, 0);
		expect(taxableSum).toBe(result.subtotalAfterDiscounts);
		// Total must equal subtotalAfterDiscounts + totalTaxes
		expect(result.total).toBe(result.subtotalAfterDiscounts + result.totalTaxes);
	});

	it('includes 0% tax row in display when it absorbed the discount-rounding remainder', () => {
		const items = [
			item({ quantity: 1, unitPrice: 667, taxRate: 0 }),
			item({ quantity: 1, unitPrice: 167, taxRate: 10 }),
			item({ quantity: 1, unitPrice: 167, taxRate: 19 })
		];
		const discounts: Discount[] = [{ type: 'percentage', value: 7, description: '' }];
		const result = computeInvoiceTotals(items, discounts, 'net');
		const taxableSum = result.taxSubtotals.reduce((s, ts) => s + ts.taxableAmount, 0);
		expect(taxableSum).toBe(result.subtotalAfterDiscounts);
		const zeroRow = result.taxSubtotals.find(ts => ts.rate === 0);
		expect(zeroRow).toBeDefined();
		expect(zeroRow!.taxAmount).toBe(0);
	});

	it('sets discountCapped flag when discount exceeds subtotal (DATA-002)', () => {
		const items = [item({ quantity: 1, unitPrice: 5000, taxRate: 19 })]; // 50€
		const discounts: Discount[] = [{ type: 'fixed', value: 10000, description: '' }]; // 100€ discount on 50€ subtotal
		const result = computeInvoiceTotals(items, discounts, 'net');
		expect(result.discountCapped).toBe(true);
		expect(result.discountAmount).toBe(5000); // capped at subtotal
		expect(result.subtotalAfterDiscounts).toBe(0);
		expect(result.total).toBe(0);
	});

	it('discountCapped is false when discount fits within subtotal (DATA-002)', () => {
		const items = [item({ quantity: 1, unitPrice: 10000, taxRate: 19 })];
		const discounts: Discount[] = [{ type: 'fixed', value: 2000, description: '' }];
		const result = computeInvoiceTotals(items, discounts, 'net');
		expect(result.discountCapped).toBe(false);
		expect(result.discountAmount).toBe(2000);
	});

	it('GROSS mode tax never flips sign relative to gross amount (DATA-003)', () => {
		const items = [item({ quantity: 1, unitPrice: 1, taxRate: 19 })]; // 1 cent gross
		const result = computeInvoiceTotals(items, [], 'gross');
		expect(result.totalTaxes).toBeGreaterThanOrEqual(0);
		expect(result.total).toBe(1); // 1 cent total
	});
});
