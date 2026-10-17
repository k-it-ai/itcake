import {
	db,
	generateId,
	getDocument,
	getDocumentsByType,
	insertDocument,
	updateDocument,
	deleteDocument
} from '#lib/server/db.js';
import { recordChange, computeDiff } from '#lib/server/changes.js';
import type { CatalogItem } from '#lib/types.js';

export function getCatalogItems(): CatalogItem[] {
	return getDocumentsByType<CatalogItem>('catalog_item');
}

export const createCatalogItem = db.transaction((
	data: Omit<CatalogItem, 'id' | 'createdAt' | 'updatedAt'>,
	userId: string
): CatalogItem => {
	const id = generateId();
	const now = new Date().toISOString();
	const item: CatalogItem = { id, ...data, createdAt: now, updatedAt: now };
	insertDocument(id, 'catalog_item', item);
	recordChange('catalog_item', id, 'create', {}, userId);
	return item;
});

export function updateCatalogItem(
	id: string,
	data: Partial<CatalogItem>,
	userId: string
): CatalogItem | null {
	return db.transaction(() => {
		const existing = getDocument<CatalogItem>(id, 'catalog_item');
		if (!existing) return null;

		const updated: CatalogItem = {
			...existing,
			...data,
			id,
			createdAt: existing.createdAt,
			updatedAt: new Date().toISOString()
		};
		const diff = computeDiff(
			existing as unknown as Record<string, unknown>,
			updated as unknown as Record<string, unknown>
		);
		updateDocument(id, updated);
		recordChange('catalog_item', id, 'update', diff, userId);
		return updated;
	})();
}

export function removeCatalogItem(id: string, userId: string): boolean {
	return db.transaction(() => {
		const existing = getDocument<CatalogItem>(id, 'catalog_item');
		if (!existing) return false;
		deleteDocument(id);
		recordChange('catalog_item', id, 'delete', {}, userId);
		return true;
	})();
}
