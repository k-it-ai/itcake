import { db, generateId, getDocument, insertDocument, updateDocument, deleteDocument, queryDocumentsPaginated, escapeSqlLike } from '$lib/server/db.js';
import type { PaginatedResult } from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
import { ServiceError } from '$lib/server/service-error.js';
import type { Expense, ExpenseCategory } from '$lib/types.js';
import { resolve, join, basename, extname } from 'node:path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { verifyMagicBytes } from '$lib/server/file-validation.js';
import { RECEIPT_DIR } from '$lib/server/data-dir.js';

function ensureReceiptDir(): void {
	if (!existsSync(RECEIPT_DIR)) mkdirSync(RECEIPT_DIR, { recursive: true });
}

const ALLOWED_MIME: Record<string, string> = {
	'image/jpeg': '.jpg',
	'image/png': '.png',
	'image/webp': '.webp',
	'application/pdf': '.pdf'
};

interface ExpenseFilters {
	category?: string;
	search?: string;
	dateFrom?: string;
	dateTo?: string;
}

export function getExpensesPaginated(filters: ExpenseFilters = {}, page = 1, pageSize = 25): PaginatedResult<Expense> {
	const queryFilters: Array<{ sql: string; params: unknown[] }> = [];

	if (filters.category) {
		queryFilters.push({ sql: "json_extract(data, '$.category') = ?", params: [filters.category] });
	}
	if (filters.search) {
		const q = `%${escapeSqlLike(filters.search)}%`;
		queryFilters.push({
			sql: "(json_extract(data, '$.description') LIKE ? ESCAPE '\\' OR json_extract(data, '$.vendor') LIKE ? ESCAPE '\\')",
			params: [q, q]
		});
	}
	if (filters.dateFrom) {
		queryFilters.push({ sql: "json_extract(data, '$.date') >= ?", params: [filters.dateFrom] });
	}
	if (filters.dateTo) {
		queryFilters.push({ sql: "json_extract(data, '$.date') <= ?", params: [filters.dateTo] });
	}

	return queryDocumentsPaginated<Expense>('expense', { filters: queryFilters, page, pageSize });
}

export function getExpense(id: string): Expense | null {
	return getDocument<Expense>(id, 'expense');
}

export const createExpense = db.transaction((data: Omit<Expense, 'id' | 'createdAt' | 'updatedAt' | 'receiptFilename'>, userId: string): Expense => {
	const id = generateId();
	const now = new Date().toISOString();
	const expense: Expense = {
		...data,
		id,
		receiptFilename: null,
		createdAt: now,
		updatedAt: now
	};
	insertDocument(id, 'expense', expense);
	recordChange('expense', id, 'create', {}, userId);
	return expense;
});

export function updateExpense(id: string, data: Partial<Omit<Expense, 'id' | 'createdAt' | 'updatedAt'>>, userId: string): Expense | null {
	return db.transaction(() => {
		const existing = getExpense(id);
		if (!existing) return null;
		const updated: Expense = {
			...existing,
			...data,
			id: existing.id,
			createdAt: existing.createdAt,
			updatedAt: new Date().toISOString()
		};
		// Re-validate invariant: taxAmount must not exceed amount after merge
		if (updated.taxAmount > updated.amount) {
			throw new ServiceError('error.taxExceedsTotal');
		}
		const diff = computeDiff(
			existing as unknown as Record<string, unknown>,
			updated as unknown as Record<string, unknown>
		);
		updateDocument(id, updated);
		recordChange('expense', id, 'update', diff, userId);
		return updated;
	})();
}

export function deleteExpense(id: string, userId: string): boolean {
	let receiptToDelete: string | null = null;
	const deleted = db.transaction(() => {
		const expense = getExpense(id);
		if (!expense) return false;
		receiptToDelete = expense.receiptFilename;
		deleteDocument(id);
		recordChange('expense', id, 'delete', {}, userId);
		return true;
	})();
	// Delete receipt file only after DB transaction commits to avoid inconsistent state
	if (deleted && receiptToDelete) {
		deleteReceiptFile(receiptToDelete);
	}
	return deleted;
}

export async function saveReceiptBuffer(expenseId: string, buffer: Buffer, mimeType: string): Promise<string> {
	ensureReceiptDir();

	const ext = ALLOWED_MIME[mimeType];
	if (!ext) throw new ServiceError('error.invalidReceiptType');
	if (buffer.length > 10 * 1024 * 1024) throw new ServiceError('error.receiptFileTooLarge');

	const filename = `${expenseId}${ext}`;
	const safeName = basename(filename);
	const destPath = resolve(join(RECEIPT_DIR, safeName));
	if (!destPath.startsWith(RECEIPT_DIR + '/')) throw new Error('Invalid path');
	if (!verifyMagicBytes(buffer, mimeType)) throw new ServiceError('error.receiptContentMismatch');

	// Write new file first, then delete old receipts with different extensions.
	// This order prevents data loss if writeFileSync fails (disk full, permissions).
	writeFileSync(destPath, buffer);
	deleteOtherReceipts(expenseId, ext);
	return filename;
}

export function getReceiptPath(filename: string): string | null {
	const safeName = basename(filename);
	if (!safeName || safeName !== filename || safeName.includes('..')) return null;
	const ext = extname(safeName).toLowerCase();
	if (!['.jpg', '.png', '.webp', '.pdf'].includes(ext)) return null;
	const filePath = resolve(join(RECEIPT_DIR, safeName));
	if (!filePath.startsWith(RECEIPT_DIR + '/')) return null;
	if (!existsSync(filePath)) return null;
	return filePath;
}

function deleteReceiptFile(filename: string): void {
	const filePath = getReceiptPath(filename);
	if (filePath) {
		try { unlinkSync(filePath); } catch { /* ignore */ }
	}
}

/**
 * Delete receipt files for an expense that don't match the current extension.
 * Prevents orphaned files when uploading a receipt with a different format.
 */
function deleteOtherReceipts(expenseId: string, currentExt: string): void {
	for (const ext of Object.values(ALLOWED_MIME)) {
		if (ext === currentExt) continue;
		const candidate = `${expenseId}${ext}`;
		const filePath = getReceiptPath(candidate);
		if (filePath) {
			try { unlinkSync(filePath); } catch { /* ignore */ }
		}
	}
}

export const EXPENSE_CATEGORY_VALUES: ExpenseCategory[] = [
	'office', 'travel', 'software', 'equipment',
	'marketing', 'professional', 'insurance', 'utilities', 'other'
];
