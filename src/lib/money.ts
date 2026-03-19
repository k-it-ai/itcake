import { getCurrencyDecimals, getCurrencySymbol } from './currencies.js';
import type { Discount, InvoiceTotals, LineItem, PricingMode, TaxSubtotal } from './types.js';

/**
 * Format a money amount (in cents) for display.
 * Uses locale-aware formatting with the currency symbol.
 */
export function formatMoney(cents: number, currency: string, locale = 'en'): string {
	const decimals = getCurrencyDecimals(currency) ?? 2;
	const value = cents / Math.pow(10, decimals);
	const symbol = getCurrencySymbol(currency);

	const formatted = value.toLocaleString(locale, {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals
	});

	return `${symbol}${formatted}`;
}

/**
 * Round to nearest cent (integer).
 */
function roundCents(value: number): number {
	return Math.round(value);
}

/** Max recursion depth for nested line items — prevents stack overflow from malicious payloads. */
export const MAX_NESTING_DEPTH = 10;

/**
 * Compute the subtotal of a single line item (including sub-items).
 * Returns amount in cents. Depth-capped to prevent stack overflow.
 */
export function computeItemSubtotal(item: LineItem, depth = 0): number {
	if (depth > MAX_NESTING_DEPTH) return 0;
	if (item.items && item.items.length > 0) {
		// Parent item: sum of sub-item subtotals
		return item.items.reduce((sum, sub) => sum + computeItemSubtotal(sub, depth + 1), 0);
	}
	return roundCents(item.quantity * item.unitPrice);
}

/**
 * Flatten all leaf items from a recursive item tree.
 * Depth is capped to prevent stack overflow from malicious payloads.
 */
function flattenItems(items: LineItem[], depth = 0): LineItem[] {
	if (depth > MAX_NESTING_DEPTH) return [];
	const result: LineItem[] = [];
	for (const item of items) {
		if (item.items && item.items.length > 0) {
			result.push(...flattenItems(item.items, depth + 1));
		} else {
			result.push(item);
		}
	}
	return result;
}

/**
 * Compute discount amount from discounts array applied to a subtotal.
 * Each percentage discount applies to the original subtotal (standard EU invoicing).
 * The cumulative discount is capped so it never exceeds the subtotal.
 *
 * Sign handling for credit notes (negative subtotals):
 * - Percentage discounts naturally produce negative amounts (subtotal * rate)
 * - Fixed discounts are sign-matched to the subtotal direction so they reduce
 *   the magnitude rather than increasing it. This allows discount values to
 *   always be stored as positive (satisfying the Zod min(0) constraint) while
 *   still working correctly on credit notes.
 */
function computeDiscountAmount(subtotal: number, discounts: Discount[]): { amount: number; capped: boolean } {
	let total = 0;
	const absSubtotal = Math.abs(subtotal);
	const sign = subtotal >= 0 ? 1 : -1;
	for (const d of discounts) {
		if (d.type === 'percentage') {
			total += roundCents(subtotal * d.value / 100);
		} else {
			// Sign-match fixed discounts to the subtotal direction.
			// Positive subtotal: discount is positive (reduces total).
			// Negative subtotal (credit note): discount is negative (reduces credit magnitude).
			total += sign * Math.abs(d.value);
		}
	}
	// Cap: cumulative discount cannot exceed the subtotal magnitude
	let capped = false;
	if (absSubtotal > 0 && Math.abs(total) > absSubtotal) {
		total = sign * absSubtotal;
		capped = true;
	}
	return { amount: total, capped };
}

/**
 * Compute full invoice totals.
 *
 * NET mode:  prices are exclusive of tax → total = subtotalAfterDiscounts + totalTaxes
 * GROSS mode: prices are inclusive of tax → total = subtotalAfterDiscounts (taxes included)
 *
 * Flow: subtotal → discounts → subtotalAfterDiscounts → taxSubtotals[] → totalTaxes → total → netTotal
 */
export function computeInvoiceTotals(
	items: LineItem[],
	discounts: Discount[],
	pricingMode: PricingMode
): InvoiceTotals {
	// Step 1: Compute subtotal from all items
	const subtotal = items.reduce((sum, item) => sum + computeItemSubtotal(item), 0);
	if (Math.abs(subtotal) > Number.MAX_SAFE_INTEGER) {
		throw new Error('Invoice total exceeds safe numeric range');
	}

	// Step 2: Apply discounts
	// Floor at 0 for regular invoices (discount cannot exceed subtotal).
	// Credit notes (negative subtotal, no discounts) must preserve negative values.
	const discountResult = computeDiscountAmount(subtotal, discounts);
	const rawDiscountAmount = discountResult.amount;
	// Cap effective discount at subtotal for positive invoices (discount cannot exceed subtotal)
	const discountCapped = discountResult.capped || (subtotal >= 0 && rawDiscountAmount > subtotal);
	const discountAmount = subtotal >= 0 ? Math.min(rawDiscountAmount, subtotal) : rawDiscountAmount;
	const subtotalAfterDiscounts = subtotal >= 0
		? Math.max(0, subtotal - discountAmount)
		: subtotal - discountAmount;

	// Step 3: Group leaf items by tax rate and compute tax subtotals.
	// Each item is rounded to cents individually (matching computeItemSubtotal),
	// then accumulated per tax group. The discount ratio is applied per-group
	// and rounded once to produce the final taxable amount.
	const leafItems = flattenItems(items);
	const taxGroups = new Map<number, number>();

	for (const item of leafItems) {
		const itemTotal = computeItemSubtotal(item);
		if (itemTotal === 0) continue;
		const current = taxGroups.get(item.taxRate) ?? 0;
		taxGroups.set(item.taxRate, current + itemTotal);
	}

	// Apply discount proportionally across tax groups.
	// NOTE: Fixed-amount discounts are allocated proportionally across all tax groups.
	// Under EU VAT rules for mixed-rate invoices, a general discount should be distributed
	// proportionally (which this code does). However, if a fixed discount is intended to apply
	// to a specific tax bracket only, this calculation will be incorrect. There is currently
	// no UI to specify which tax group a fixed discount targets.
	const discountRatio = subtotal !== 0 ? subtotalAfterDiscounts / subtotal : 1;

	const taxSubtotals: TaxSubtotal[] = [];
	let totalTaxes = 0;

	for (const [rate, rawGroupSubtotal] of taxGroups) {
		// Apply discount ratio on unrounded accumulator, then round once
		const rawAdjusted = rawGroupSubtotal >= 0
			? Math.max(0, rawGroupSubtotal * discountRatio)
			: rawGroupSubtotal * discountRatio;

		let taxAmount: number;
		let taxableAmount: number;
		if (pricingMode === 'net') {
			// NET: tax is added on top — round base and tax independently
			taxableAmount = roundCents(rawAdjusted);
			taxAmount = roundCents(rawAdjusted * rate / 100);
		} else {
			// GROSS: tax is included in the price — derive taxable base first,
			// then compute tax as the residual so the breakdown always sums exactly
			// to roundCents(rawAdjusted) (EU VAT rounding requirement)
			taxableAmount = roundCents(rawAdjusted / (1 + rate / 100));
			taxAmount = roundCents(rawAdjusted) - taxableAmount;
			// Defensive: ensure tax doesn't flip sign relative to gross amount.
			// Should never happen with correct math, but guards against rounding edge cases.
			if (rawAdjusted >= 0 && taxAmount < 0) taxAmount = 0;
			if (rawAdjusted < 0 && taxAmount > 0) taxAmount = 0;
		}

		taxSubtotals.push({ rate, taxableAmount, taxAmount });
		totalTaxes += taxAmount;
	}

	// Rounding reconciliation: when discounts are distributed proportionally across
	// tax groups, independent rounding of each group can cause the sum of taxable
	// amounts to differ from subtotalAfterDiscounts by 1-2 cents. Adjust the largest
	// group to absorb the remainder (standard accounting rounding allocation).
	if (pricingMode === 'net' && taxSubtotals.length > 1) {
		const taxableSum = taxSubtotals.reduce((s, ts) => s + ts.taxableAmount, 0);
		const remainder = subtotalAfterDiscounts - taxableSum;
		if (remainder !== 0) {
			// Find the group with the largest absolute taxable amount
			let maxIdx = 0;
			for (let i = 1; i < taxSubtotals.length; i++) {
				if (Math.abs(taxSubtotals[i].taxableAmount) > Math.abs(taxSubtotals[maxIdx].taxableAmount)) {
					maxIdx = i;
				}
			}
			taxSubtotals[maxIdx].taxableAmount += remainder;
			// Recompute tax for the adjusted group
			const adjustedTax = roundCents(taxSubtotals[maxIdx].taxableAmount * taxSubtotals[maxIdx].rate / 100);
			totalTaxes += adjustedTax - taxSubtotals[maxIdx].taxAmount;
			taxSubtotals[maxIdx].taxAmount = adjustedTax;
		}
	}

	// Sort tax subtotals by rate, exclude 0% tax lines
	taxSubtotals.sort((a, b) => a.rate - b.rate);
	const filteredTaxSubtotals = taxSubtotals.filter(ts => ts.rate > 0);

	// Step 4: Compute total
	let total: number;
	if (pricingMode === 'net') {
		total = subtotalAfterDiscounts + totalTaxes;
	} else {
		total = subtotalAfterDiscounts; // taxes already included
	}

	// Overflow check on final total
	if (Math.abs(total) > Number.MAX_SAFE_INTEGER) {
		throw new Error('Invoice total exceeds safe numeric range');
	}

	// netTotal is the amount excluding taxes
	const netTotal = total - totalTaxes;

	return {
		subtotal,
		discountAmount,
		subtotalAfterDiscounts,
		taxSubtotals: filteredTaxSubtotals,
		totalTaxes,
		total,
		netTotal,
		discountCapped
	};
}
