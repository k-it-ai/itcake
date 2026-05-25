import { error, fail, isHttpError } from '@sveltejs/kit';
import type { ActionFailure } from '@sveltejs/kit';
import { ServiceError } from '$lib/server/service-error.js';
import { getSetting } from '$lib/server/db.js';
import { serverT } from '$lib/i18n/server.js';
import type { GeneralSettings } from '$lib/types.js';

const MAX_JSON_BODY_SIZE = 1_048_576; // 1MB

export async function parseJsonBody<T = unknown>(request: Request): Promise<T> {
	const ct = request.headers.get('content-type');
	if (!ct || !ct.startsWith('application/json')) {
		throw error(415, 'Content-Type must be application/json');
	}
	const rawCL = request.headers.get('content-length') ?? '';
	const num = Number(rawCL);
	const contentLength = Number.isInteger(num) && num >= 0 ? num : 0;
	if (contentLength > MAX_JSON_BODY_SIZE) {
		throw error(413, 'Request body too large (max 1MB)');
	}
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

const BANNED_PARTIAL_KEYS = new Set([
	'__proto__', 'constructor', 'prototype',
	'__defineGetter__', '__defineSetter__',
	'__lookupGetter__', '__lookupSetter__'
]);

export function pickPresentKeys<T extends Record<string, unknown>>(
	parsed: T,
	input: Record<string, unknown>
): Partial<T> {
	const result: Partial<T> = {};
	for (const key of Object.keys(input)) {
		if (BANNED_PARTIAL_KEYS.has(key)) continue;
		if (Object.prototype.hasOwnProperty.call(parsed, key)) {
			result[key as keyof T] = parsed[key as keyof T];
		}
	}
	return result;
}

export function notFound(): never {
	const lang = getSetting<GeneralSettings>('general').language || 'en';
	throw error(404, serverT(lang)('error.notFound'));
}

export function requireUser(
	locals: { user: { id: string } | null },
	message?: string
): asserts locals is { user: { id: string } } {
	if (!locals.user) throw error(401, message);
}

export function requireAdmin(
	locals: { user: { id: string; role?: string } | null },
	message?: string
): asserts locals is { user: { id: string; role: 'admin' } } {
	if (!locals.user) throw error(401, message);
	if (locals.user.role !== 'admin') throw error(403, message ?? 'Admin only');
}

export function requireId(data: Record<string, unknown>): string {
	const id = data.id;
	if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
	return id;
}

interface ZodLike<T> {
	safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
}

export function parseUpdateBody<T extends Record<string, unknown>>(
	schema: ZodLike<T>,
	input: Record<string, unknown>
): Partial<T> {
	const result = schema.safeParse(input);
	if (!result.success) throw error(400, result.error.issues[0].message);
	return pickPresentKeys(result.data, input);
}

type ActionHandler = (
	data: Record<string, unknown>,
	userId: string
) => Response | Promise<Response>;

interface ActionRouteConfig {
	create: ActionHandler;
	actions?: Record<string, ActionHandler>;
}

export async function handleActionPost(
	request: Request,
	locals: { user: { id: string } | null },
	config: ActionRouteConfig
): Promise<Response> {
	if (!locals.user) throw error(401);
	const body = await parseJsonBody<Record<string, unknown>>(request);
	const action = body.action;
	if (action !== undefined && typeof action !== 'string') {
		throw error(400, 'Invalid action');
	}
	if (action) {
		const handler = config.actions
			&& Object.prototype.hasOwnProperty.call(config.actions, action)
				? config.actions[action] : undefined;
		if (typeof handler !== 'function') throw error(400, 'Invalid action');
	}
	const data: Record<string, unknown> = { ...body };
	delete data.action;
	try {
		const handler = action ? config.actions![action] : config.create;
		return await handler(data, locals.user.id);
	} catch (e) {
		return translateServiceError(e);
	}
}

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
	'error.invalidStatusTransition': 400,
	'error.cannotConvertProposalStatus': 400,
	'error.cannotDuplicateCreditNote': 400,
	'error.dueDateBeforeIssueDate': 400,
	'error.validUntilBeforeIssueDate': 400,
	'error.tooManyPdfRequests': 429,
	'error.pdfGenerationUnavailable': 503,
};

export function translateServiceError(e: unknown): never {
	if (isHttpError(e)) throw e;

	if (e instanceof ServiceError) {
		const lang = getSetting<GeneralSettings>('general').language || 'en';
		const msg = serverT(lang)(e.i18nKey, e.params);
		const status = SERVICE_ERROR_STATUS[e.i18nKey] ?? 400;
		throw error(status, msg);
	}

	if (e instanceof Error && e.message.includes('not found')) {
		throw error(404, 'Resource not found');
	}
	throw e;
}

export function failFromServiceError(e: unknown, lang: string): ActionFailure<{ error: string }> | null {
	if (!(e instanceof ServiceError)) return null;
	const status = SERVICE_ERROR_STATUS[e.i18nKey] ?? 400;
	const msg = serverT(lang)(e.i18nKey, e.params);
	return fail(status, { error: msg });
}
