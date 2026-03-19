import { db, generateId, getDocument, insertDocument, updateDocument, deleteDocument } from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
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

const stmtGetExpenses = db.prepare('SELECT data FROM documents WHERE type = ? ORDER BY created_at DESC');

export function getExpenses(): Expense[] {
	const rows = stmtGetExpenses.all('expense') as { data: string }[];
	return rows.map(r => JSON.parse(r.data) as Expense);
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
			throw new Error('Tax amount cannot exceed total amount');
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
	if (!ext) throw new Error('Invalid file type. Allowed: JPEG, PNG, WebP, PDF');
	if (buffer.length > 10 * 1024 * 1024) throw new Error('File too large (max 10MB)');

	const filename = `${expenseId}${ext}`;
	const safeName = basename(filename);
	const destPath = resolve(join(RECEIPT_DIR, safeName));
	if (!destPath.startsWith(RECEIPT_DIR + '/')) throw new Error('Invalid path');
	if (!verifyMagicBytes(buffer, mimeType)) throw new Error('File content does not match declared type');

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
