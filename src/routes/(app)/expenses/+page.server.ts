import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types.js';
import { getExpenses, createExpense, updateExpense, deleteExpense, saveReceiptBuffer, EXPENSE_CATEGORY_VALUES } from '$services/expenses.js';
import { expenseSchema } from '$lib/validators.js';
import { getSetting } from '$lib/server/db.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const general = getSetting<{ currency?: string; dateFormat?: string }>('general');
	return {
		expenses: getExpenses(),
		currency: general.currency ?? 'EUR',
		dateFormat: general.dateFormat ?? 'DD/MM/YYYY',
		categories: EXPENSE_CATEGORY_VALUES
	};
};

function parseExpenseForm(formData: FormData) {
	const rawAmount = parseInt(formData.get('amount') as string, 10);
	const rawTaxAmount = parseInt(formData.get('taxAmount') as string, 10);
	return {
		date: formData.get('date') as string,
		description: formData.get('description') as string,
		amount: Number.isNaN(rawAmount) ? -1 : rawAmount, // -1 triggers Zod min(0) rejection
		taxAmount: Number.isNaN(rawTaxAmount) ? 0 : rawTaxAmount,
		currency: formData.get('currency') as string || 'EUR',
		category: formData.get('category') as string || 'other',
		vendor: formData.get('vendor') as string || '',
		notes: formData.get('notes') as string || ''
	};
}

async function handleReceipt(formData: FormData, expenseId: string, userId: string): Promise<string | undefined> {
	const receipt = formData.get('receipt') as File | null;
	if (!receipt || receipt.size === 0) return;
	if (receipt.size > 10 * 1024 * 1024) throw new Error('File too large (max 10MB)');
	const buffer = Buffer.from(await receipt.arrayBuffer());
	const filename = await saveReceiptBuffer(expenseId, buffer, receipt.type);
	updateExpense(expenseId, { receiptFilename: filename }, userId);
	return undefined;
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const formData = await request.formData();

		const parsed = expenseSchema.safeParse(parseExpenseForm(formData));
		if (!parsed.success) return fail(400, { error: parsed.error.errors[0].message });

		const expense = createExpense(parsed.data, locals.user.id);

		try {
			await handleReceipt(formData, expense.id, locals.user.id);
		} catch (e) {
			return { success: true, receiptError: (e as Error).message };
		}

		return { success: true };
	},

	update: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const formData = await request.formData();
		const id = formData.get('id') as string;
		if (!id) return fail(400, { error: 'Missing id' });

		const parsed = expenseSchema.safeParse(parseExpenseForm(formData));
		if (!parsed.success) return fail(400, { error: parsed.error.errors[0].message });

		const updated = updateExpense(id, parsed.data, locals.user.id);
		if (!updated) return fail(404, { error: 'Expense not found' });

		try {
			await handleReceipt(formData, id, locals.user.id);
		} catch (e) {
			return { success: true, receiptError: (e as Error).message };
		}

		return { success: true };
	},

	delete: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const formData = await request.formData();
		const id = formData.get('id') as string;
		if (!id) return fail(400, { error: 'Missing id' });
		if (!deleteExpense(id, locals.user.id)) return fail(404, { error: 'Expense not found' });
		return { success: true };
	}
};
