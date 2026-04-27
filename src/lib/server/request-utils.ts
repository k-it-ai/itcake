import { error, json, isHttpError } from '@sveltejs/kit';
import { ServiceError } from '$lib/server/service-error.js';
import { getSetting } from '$lib/server/db.js';
import { serverT } from '$lib/i18n/server.js';
import type { GeneralSettings } from '$lib/types.js';

const MAX_JSON_BODY_SIZE = 1_048_576; // 1MB

/**
 * Parse JSON from a Request body with proper error handling.
 * Returns 400 Bad Request instead of 500 on malformed JSON.
 * Rejects payloads exceeding 1MB to prevent memory exhaustion.
 *
 * Reads body as text and checks actual length rather than trusting
 * Content-Length (which is absent in chunked transfer encoding).
 */
export async function parseJsonBody<T = unknown>(request: Request): Promise<T> {
	// Reject explicit non-JSON Content-Types (absent Content-Type is accepted for compat)
	const ct = request.headers.get('content-type');
	if (ct && !ct.startsWith('application/json') && !ct.startsWith('text/json')) {
		throw error(415, 'Content-Type must be application/json');
	}
	// Fast reject via Content-Length when present (avoids buffering obvious oversized payloads)
	const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10);
	if (contentLength > MAX_JSON_BODY_SIZE) {
		throw error(413, 'Request body too large (max 1MB)');
	}
	// Streaming reader: accumulate chunks with a byte counter that aborts on limit.
	// Prevents buffering a multi-GB chunked body into memory before the size check.
	const body = request.body;
	if (!body) {
		throw error(400, 'Empty request body');
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_JSON_BODY_SIZE) {
				reader.cancel();
				throw error(413, 'Request body too large (max 1MB)');
			}
			chunks.push(value);
		}
	} catch (e) {
		if (isHttpError(e)) throw e;
		throw error(400, 'Failed to read request body');
	}
	const decoder = new TextDecoder();
	const text = chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw error(400, 'Invalid or malformed JSON body');
	}
}

/**
 * Zod 4 changed `.partial()` to preserve `.default()` values, so a partial
 * schema fills in defaults for keys the caller never sent. For PATCH-style
 * updates we want to apply only the keys the caller actually provided —
 * otherwise an update of `{notes: 'x'}` would overwrite templateId, status,
 * etc. with their schema defaults.
 */
export function pickPresentKeys<T extends Record<string, unknown>>(
	parsed: T,
	input: Record<string, unknown>
): Partial<T> {
	const result: Partial<T> = {};
	for (const key of Object.keys(input)) {
		if (key in parsed) result[key as keyof T] = parsed[key as keyof T];
	}
	return result;
}

/** HTTP status code mapping for ServiceError i18n keys. */
const SERVICE_ERROR_STATUS: Record<string, number> = {
	'error.invoiceEditLocked': 403,
	'error.invoiceFieldFrozenAfterSend': 403,
	'error.tooManyRecipients': 400,
	'error.passwordTooLongForBcrypt': 400,
	'error.cannotEditAcceptedProposal': 403,
	'error.statusViaDedicatedEndpoint': 400,
	'error.cannotEditInvoicedTicket': 403,
	'error.cannotDeleteNonDraftCreditNote': 403,
	'error.invoiceHasLinkedCreditNotes': 403,
	'error.cannotDeleteAcceptedProposal': 403,
	'error.cannotDeleteInvoicedTicket': 403,
	'error.cannotDeleteClientWithLinkedDocs': 403,
	'error.currentPasswordIncorrect': 403,
	'error.cannotCreateCreditNoteForCreditNote': 400,
	'error.creditNoteOnlyForSentPaidOverdue': 400,
	'error.creditNoteAlreadyExists': 409,
	'error.invoiceLockedFromEditing': 403,
	'error.notFound': 404,
	'error.clientNumberInUse': 409,
	'error.monitorLimitReached': 429,
	'error.mfaAlreadyEnabled': 409,
	'error.mfaNotEnabled': 409,
	'error.mfaCodeInvalid': 401,
	'error.mfaRecoveryCodesInvalid': 400,
	'error.scheduleCronInvalid': 400,
	'error.scheduleNameRequired': 400,
	'error.alertNameRequired': 400,
	'error.bulkDispatchNoTargets': 400,
	'error.bulkDispatchNoMatch': 404,
};

/**
 * Translate service-layer errors to HTTP status codes.
 * Detects ServiceError for i18n translation, falls back to message pattern matching.
 * Re-throws unknown errors as-is (will become 500).
 */
export function translateServiceError(e: unknown): never {
	if (isHttpError(e)) throw e;

	// ServiceError: translate using i18n and map to appropriate HTTP status
	if (e instanceof ServiceError) {
		const lang = getSetting<GeneralSettings>('general').language || 'en';
		const msg = serverT(lang)(e.i18nKey, e.params);
		const status = SERVICE_ERROR_STATUS[e.i18nKey] ?? 400;
		throw error(status, msg);
	}

	// Fallback: pattern-match on raw Error messages (legacy / non-ServiceError throws).
	// Use generic messages to prevent internal error details from leaking to the client.
	if (e instanceof Error) {
		if (e.message.includes('locked')) throw error(403, 'This resource is locked from editing');
		if (e.message.includes('Cannot transition')) throw error(400, 'Invalid status transition');
		if (e.message.includes('Cannot edit')) throw error(403, 'This resource cannot be edited');
		if (e.message.includes('Cannot delete')) throw error(403, 'This resource cannot be deleted');
		if (e.message.includes('Cannot convert')) throw error(400, 'This conversion is not allowed');
		if (e.message.includes('Cannot create a credit note')) throw error(400, 'Credit note cannot be created for this invoice');
		if (e.message.includes('Cannot set')) throw error(400, 'Invalid operation');
		if (e.message.includes('not found')) throw error(404, 'Resource not found');
		if (e.message.includes('already in use')) throw error(409, 'This value is already in use');
		if (e.message.includes('conflicts')) throw error(409, 'Resource conflict');
	}
	throw e;
}
