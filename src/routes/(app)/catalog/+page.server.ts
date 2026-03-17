import type { Actions, PageServerLoad } from './$types.js';
import { fail, redirect } from '@sveltejs/kit';
import { getCatalogItems, createCatalogItem, updateCatalogItem, removeCatalogItem } from '$services/catalog-items.js';
import { getUnits, createUnit, updateUnit, removeUnit } from '$services/units.js';
import { catalogItemSchema, unitSchema } from '$lib/validators.js';

export const load: PageServerLoad = async ({ locals, parent }) => {
	if (!locals.user) throw redirect(302, '/login');
	const parentData = await parent();
	const currency = parentData.settings?.general?.currency ?? 'EUR';
	return {
		catalogItems: getCatalogItems(),
		units: getUnits(),
		currency
	};
};

function parseCatalogItemForm(formData: FormData) {
	return {
		name: formData.get('name') as string,
		description: (formData.get('description') as string) || '',
		unitPrice: parseInt(formData.get('unitPrice') as string, 10) || 0,
		unit: (formData.get('unit') as string) || '',
		taxRate: parseFloat(formData.get('taxRate') as string) || 0
	};
}

export const actions: Actions = {
	createItem: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const formData = await request.formData();

		const result = catalogItemSchema.safeParse(parseCatalogItemForm(formData));
		if (!result.success) return fail(400, { error: result.error.issues[0].message });

		createCatalogItem(result.data, locals.user.id);
		return { success: true };
	},

	updateItem: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const formData = await request.formData();
		const id = formData.get('id') as string;
		if (!id) return fail(400, { error: 'Missing id' });

		const result = catalogItemSchema.safeParse(parseCatalogItemForm(formData));
		if (!result.success) return fail(400, { error: result.error.issues[0].message });

		const updated = updateCatalogItem(id, result.data, locals.user.id);
		if (!updated) return fail(404, { error: 'Item not found' });

		return { success: true };
	},

	deleteItem: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const formData = await request.formData();
		const id = formData.get('id') as string;
		if (!id) return fail(400, { error: 'Missing id' });
		if (!removeCatalogItem(id, locals.user.id)) return fail(404, { error: 'Item not found' });
		return { success: true };
	},

	createUnit: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const formData = await request.formData();
		const name = formData.get('name') as string;

		const result = unitSchema.safeParse({ name });
		if (!result.success) return fail(400, { error: result.error.issues[0].message });

		createUnit(result.data.name, locals.user.id);
		return { success: true };
	},

	updateUnit: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const formData = await request.formData();
		const id = formData.get('id') as string;
		if (!id) return fail(400, { error: 'Missing id' });
		const name = formData.get('name') as string;

		const result = unitSchema.safeParse({ name });
		if (!result.success) return fail(400, { error: result.error.issues[0].message });

		const updated = updateUnit(id, result.data.name, locals.user.id);
		if (!updated) return fail(404, { error: 'Unit not found' });

		return { success: true };
	},

	deleteUnit: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const formData = await request.formData();
		const id = formData.get('id') as string;
		if (!id) return fail(400, { error: 'Missing id' });
		if (!removeUnit(id, locals.user.id)) return fail(404, { error: 'Unit not found' });
		return { success: true };
	}
};
