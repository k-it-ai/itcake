import {
	db,
	generateId,
	getDocument,
	getDocumentsByType,
	insertDocument,
	updateDocument,
	deleteDocument
} from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import type { Unit } from '$lib/types.js';

export function getUnits(): Unit[] {
	return getDocumentsByType<Unit>('unit');
}

export const createUnit = db.transaction((name: string, userId?: string): Unit => {
	const id = generateId();
	const unit: Unit = {
		id,
		name,
		createdAt: new Date().toISOString()
	};
	insertDocument(id, 'unit', unit);
	if (userId) recordChange('unit', id, 'create', {}, userId);
	return unit;
});

export function updateUnit(id: string, name: string, userId?: string): Unit | null {
	return db.transaction(() => {
		const existing = getDocument<Unit>(id, 'unit');
		if (!existing) return null;

		const updated: Unit = { ...existing, name };
		updateDocument(id, updated);
		if (userId) {
			recordChange('unit', id, 'update', {
				name: { old: existing.name, new: name }
			}, userId);
		}
		return updated;
	})();
}

export function removeUnit(id: string, userId?: string): boolean {
	return db.transaction(() => {
		const existing = getDocument<Unit>(id, 'unit');
		if (!existing) return false;
		deleteDocument(id);
		if (userId) recordChange('unit', id, 'delete', {}, userId);
		return true;
	})();
}
