import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isHttpError } from '@sveltejs/kit';

const TEST_DIR = path.resolve('data-test-translate-svc-err');

let translateServiceError: typeof import('../../src/lib/server/request-utils.js').translateServiceError;
let failFromServiceError: typeof import('../../src/lib/server/request-utils.js').failFromServiceError;
let ServiceError: typeof import('../../src/lib/server/service-error.js').ServiceError;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'tse.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const ru = await import('../../src/lib/server/request-utils.js');
	translateServiceError = ru.translateServiceError;
	failFromServiceError = ru.failFromServiceError;
	ServiceError = (await import('../../src/lib/server/service-error.js')).ServiceError;
});

describe('translateServiceError', () => {
	function statusOf(key: string, params?: Record<string, string | number>): number {
		try {
			translateServiceError(new ServiceError(key, params));
		} catch (e) {
			if (isHttpError(e)) return e.status;
			throw e;
		}
		throw new Error('did not throw');
	}

	it('maps generatePdf throws to the right HTTP statuses (M4 regression)', () => {
		expect(statusOf('error.tooManyPdfRequests')).toBe(429);
		expect(statusOf('error.pdfGenerationUnavailable')).toBe(503);
	});

	it('maps invalid status transitions to 400 (M3 regression)', () => {
		expect(statusOf('error.invalidStatusTransition', { from: 'paid', to: 'draft' })).toBe(400);
	});

	it('maps known 403/409/404 keys correctly', () => {
		expect(statusOf('error.invoiceEditLocked')).toBe(403);
		expect(statusOf('error.cannotEditAcceptedProposal')).toBe(403);
		expect(statusOf('error.creditNoteAlreadyExists')).toBe(409);
		expect(statusOf('error.notFound')).toBe(404);
	});

	it('falls back to 400 for unknown keys', () => {
		expect(statusOf('error.someTotallyMadeUpKey')).toBe(400);
	});
});

describe('failFromServiceError', () => {
	it('returns ActionFailure with translated message for ServiceError', () => {
		const f = failFromServiceError(
			new ServiceError('error.invalidStatusTransition', { from: 'paid', to: 'draft' }),
			'en'
		);
		expect(f).not.toBeNull();
		// ActionFailure shape: { status, data }
		const ff = f as unknown as { status: number; data: { error: string } };
		expect(ff.status).toBe(400);
		expect(ff.data.error).toContain('Cannot transition');
		expect(ff.data.error).not.toContain('error.');
	});

	it('returns null for non-ServiceError input', () => {
		expect(failFromServiceError(new Error('something else'), 'en')).toBeNull();
		expect(failFromServiceError(null, 'en')).toBeNull();
		expect(failFromServiceError('string error', 'en')).toBeNull();
	});

	it('returns 503 for pdfGenerationUnavailable (M4)', () => {
		const f = failFromServiceError(new ServiceError('error.pdfGenerationUnavailable'), 'en');
		const ff = f as unknown as { status: number; data: { error: string } };
		expect(ff.status).toBe(503);
		expect(ff.data.error).toContain('PDF');
	});
});
