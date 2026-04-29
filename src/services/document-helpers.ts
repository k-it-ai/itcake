import { MAX_NESTING_DEPTH, computeInvoiceTotals } from '$lib/money.js';
import { ServiceError } from '$lib/server/service-error.js';
import type { CompanySettings, Client, SellerInfo, BuyerInfo, LineItem, InvoiceTotals, Discount, PricingMode } from '$lib/types.js';

/** Throws ServiceError if the requested status transition is not in the map. */
export function validateTransition<S extends string>(
	transitionMap: Record<S, S[]>,
	currentStatus: S,
	newStatus: S
): void {
	const allowed = transitionMap[currentStatus] ?? [];
	if (!allowed.includes(newStatus)) {
		throw new ServiceError('error.invalidStatusTransition', { from: currentStatus, to: newStatus });
	}
}

/**
 * Pick only the specified keys from an object (returns a new object).
 * Used by updateInvoice/updateProposal to enforce mutable-field allowlists.
 */
export function pickFields<T extends Record<string, unknown>>(obj: Partial<T>, keys: Set<keyof T>): Partial<T> {
	const result: Partial<T> = {};
	for (const key of keys) {
		if (key in obj) {
			(result as Record<string, unknown>)[key as string] = obj[key];
		}
	}
	return result;
}

/**
 * Build seller info from company settings.
 * Shared between invoice and proposal creation.
 */
export function buildSellerInfo(company: CompanySettings): SellerInfo {
	return {
		name: company.name ?? '',
		email: company.email ?? '',
		phone: company.phone ?? '',
		website: company.website ?? '',
		taxNumber: company.taxNumber ?? '',
		vatNumber: company.vatNumber ?? '',
		registrationNumber: company.registrationNumber ?? '',
		address: company.address ?? { street: '', city: '', zip: '', state: '', country: '' },
		logoUrl: company.logoUrl ?? '',
		bankName: company.bankName ?? '',
		bankAccount: company.bankAccount ?? '',
		bankIban: company.bankIban ?? '',
		bankSwift: company.bankSwift ?? '',
		legalInfo: company.legalInfo ?? ''
	};
}

/**
 * Build buyer info from a client record.
 * Shared between invoice and proposal creation.
 */
export function buildBuyerInfo(client: Client): BuyerInfo {
	return {
		name: client.name ?? '',
		email: client.email ?? '',
		phone: client.phone ?? '',
		vatNumber: client.vatNumber ?? '',
		registrationNumber: client.registrationNumber ?? '',
		contactPerson: client.contactPerson ?? '',
		address: client.address ?? { street: '', city: '', zip: '', state: '', country: '' }
	};
}

/**
 * Recursively zero out tax rates on all line items.
 * Used when Kleinunternehmerregelung (§19 UStG) is active.
 * Shared between invoice and proposal creation/update.
 * Depth-capped to match MAX_NESTING_DEPTH in money.ts.
 */
export function zeroTaxRates(items: LineItem[], depth = 0): LineItem[] {
	if (depth > MAX_NESTING_DEPTH) return items.map(item => ({ ...item, taxRate: 0, items: [] }));
	return items.map(item => ({
		...item,
		taxRate: 0,
		items: item.items ? zeroTaxRates(item.items, depth + 1) : []
	}));
}

/**
 * Recompute totals when items, discounts, or pricing mode changed.
 * Uses the kleinunternehmer snapshot from the existing document.
 */
export function recomputeTotals(
	existing: { kleinunternehmer?: boolean; items: LineItem[]; discounts: Discount[]; pricingMode: PricingMode; totals: InvoiceTotals },
	data: { items?: LineItem[]; discounts?: Discount[]; pricingMode?: PricingMode }
): { totals: InvoiceTotals; resolvedItems?: LineItem[] } {
	if (!data.items && !data.discounts && !data.pricingMode) {
		return { totals: existing.totals };
	}
	const isKU = existing.kleinunternehmer === true;
	const rawItems = data.items ?? existing.items;
	const resolvedItems = isKU ? zeroTaxRates(rawItems) : rawItems;
	const discounts = data.discounts ?? existing.discounts;
	const pricingMode = data.pricingMode ?? existing.pricingMode;
	return { totals: computeInvoiceTotals(resolvedItems, discounts, pricingMode), resolvedItems };
}
