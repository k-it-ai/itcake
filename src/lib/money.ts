import { getCurrencyDecimals, getCurrencySymbol } from './currencies.js';
import type { Discount, InvoiceTotals, LineItem, PricingMode, TaxSubtotal } from './types.js';

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

/** Half away from zero — Math.round() biases halves towards +∞, drifting mirrored (credit-note) amounts apart. */
function roundCents(value: number): number {
	return Math.sign(value) * Math.round(Math.abs(value));
}

export const MAX_NESTING_DEPTH = 10;

export function computeItemSubtotal(item: LineItem, depth = 0): number {
	if (depth > MAX_NESTING_DEPTH) return 0;
	if (item.items && item.items.length > 0) {
		return item.items.reduce((sum, sub) => sum + computeItemSubtotal(sub, depth + 1), 0);
	}
	return roundCents(item.quantity * item.unitPrice);
}

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

function computeDiscountAmount(subtotal: number, discounts: Discount[]): { amount: number; capped: boolean } {
	let total = 0;
	const absSubtotal = Math.abs(subtotal);
	const sign = subtotal >= 0 ? 1 : -1;
	for (const d of discounts) {
		if (d.type === 'percentage') {
			total += roundCents(subtotal * d.value / 100);
		} else {
			total += sign * Math.abs(d.value);
		}
	}
	let capped = false;
	if (absSubtotal > 0 && Math.abs(total) > absSubtotal) {
		total = sign * absSubtotal;
		capped = true;
	}
	return { amount: total, capped };
}

export function computeInvoiceTotals(
	items: LineItem[],
	discounts: Discount[],
	pricingMode: PricingMode
): InvoiceTotals {
	const subtotal = items.reduce((sum, item) => sum + computeItemSubtotal(item), 0);
	if (Math.abs(subtotal) > Number.MAX_SAFE_INTEGER) {
		throw new Error('Invoice total exceeds safe numeric range');
	}

	const discountResult = computeDiscountAmount(subtotal, discounts);
	const rawDiscountAmount = discountResult.amount;
	const discountCapped = discountResult.capped || (subtotal >= 0 && rawDiscountAmount > subtotal);
	const discountAmount = subtotal >= 0 ? Math.min(rawDiscountAmount, subtotal) : rawDiscountAmount;
	const subtotalAfterDiscounts = subtotal >= 0
		? Math.max(0, subtotal - discountAmount)
		: subtotal - discountAmount;

	const leafItems = flattenItems(items);
	const taxGroups = new Map<number, number>();

	for (const item of leafItems) {
		const itemTotal = computeItemSubtotal(item);
		if (itemTotal === 0) continue;
		const current = taxGroups.get(item.taxRate) ?? 0;
		taxGroups.set(item.taxRate, current + itemTotal);
	}

	const discountRatio = subtotal !== 0 ? subtotalAfterDiscounts / subtotal : 1;

	const taxSubtotals: TaxSubtotal[] = [];
	let totalTaxes = 0;

	for (const [rate, rawGroupSubtotal] of taxGroups) {
		const rawAdjusted = rawGroupSubtotal >= 0
			? Math.max(0, rawGroupSubtotal * discountRatio)
			: rawGroupSubtotal * discountRatio;

		let taxAmount: number;
		let taxableAmount: number;
		if (pricingMode === 'net') {
			taxableAmount = roundCents(rawAdjusted);
			taxAmount = roundCents(rawAdjusted * rate / 100);
		} else {
			taxableAmount = roundCents(rawAdjusted / (1 + rate / 100));
			taxAmount = roundCents(rawAdjusted) - taxableAmount;
			if (rawAdjusted >= 0 && taxAmount < 0) taxAmount = 0;
			if (rawAdjusted < 0 && taxAmount > 0) taxAmount = 0;
		}

		taxSubtotals.push({ rate, taxableAmount, taxAmount });
		totalTaxes += taxAmount;
	}

	// Track by reference — trailing .sort() invalidates indices.
	let absorbedZeroRateEntry: TaxSubtotal | null = null;

	if (pricingMode === 'net' && taxSubtotals.length > 1) {
		const taxableSum = taxSubtotals.reduce((s, ts) => s + ts.taxableAmount, 0);
		const remainder = subtotalAfterDiscounts - taxableSum;
		if (remainder !== 0) {
			let maxIdx = 0;
			for (let i = 1; i < taxSubtotals.length; i++) {
				if (Math.abs(taxSubtotals[i].taxableAmount) > Math.abs(taxSubtotals[maxIdx].taxableAmount)) {
					maxIdx = i;
				}
			}
			taxSubtotals[maxIdx].taxableAmount += remainder;
			const adjustedTax = roundCents(taxSubtotals[maxIdx].taxableAmount * taxSubtotals[maxIdx].rate / 100);
			totalTaxes += adjustedTax - taxSubtotals[maxIdx].taxAmount;
			taxSubtotals[maxIdx].taxAmount = adjustedTax;
			if (taxSubtotals[maxIdx].rate === 0) absorbedZeroRateEntry = taxSubtotals[maxIdx];
		}
	}

	if (pricingMode === 'gross' && taxSubtotals.length > 1) {
		const grossSum = taxSubtotals.reduce((s, ts) => s + ts.taxableAmount + ts.taxAmount, 0);
		const remainder = subtotalAfterDiscounts - grossSum;
		if (remainder !== 0) {
			let maxIdx = 0;
			for (let i = 1; i < taxSubtotals.length; i++) {
				if (Math.abs(taxSubtotals[i].taxableAmount) > Math.abs(taxSubtotals[maxIdx].taxableAmount)) {
					maxIdx = i;
				}
			}
			const adjustedGross = taxSubtotals[maxIdx].taxableAmount + taxSubtotals[maxIdx].taxAmount + remainder;
			const newTaxable = roundCents(adjustedGross / (1 + taxSubtotals[maxIdx].rate / 100));
			const newTax = adjustedGross - newTaxable;
			totalTaxes += newTax - taxSubtotals[maxIdx].taxAmount;
			taxSubtotals[maxIdx].taxableAmount = newTaxable;
			taxSubtotals[maxIdx].taxAmount = newTax;
			if (taxSubtotals[maxIdx].rate === 0) absorbedZeroRateEntry = taxSubtotals[maxIdx];
		}
	}

	taxSubtotals.sort((a, b) => a.rate - b.rate);
	const filteredTaxSubtotals = taxSubtotals.filter((ts) => ts.rate > 0 || ts === absorbedZeroRateEntry);

	let total: number;
	if (pricingMode === 'net') {
		total = subtotalAfterDiscounts + totalTaxes;
	} else {
		total = subtotalAfterDiscounts;
	}

	if (Math.abs(total) > Number.MAX_SAFE_INTEGER) {
		throw new Error('Invoice total exceeds safe numeric range');
	}

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
