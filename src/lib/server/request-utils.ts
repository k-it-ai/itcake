import { error, isHttpError } from '@sveltejs/kit';

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
 * Translate service-layer errors to HTTP status codes.
 * Maps known error message patterns to appropriate 4xx responses.
 * Re-throws unknown errors as-is (will become 500).
 */
export function translateServiceError(e: unknown): never {
	if (isHttpError(e)) throw e;
	if (e instanceof Error) {
		if (e.message.includes('locked')) throw error(403, e.message);
		if (e.message.includes('Cannot transition')) throw error(400, e.message);
		if (e.message.includes('Cannot edit')) throw error(403, e.message);
		if (e.message.includes('Cannot delete')) throw error(403, e.message);
		if (e.message.includes('Cannot convert')) throw error(400, e.message);
		if (e.message.includes('Cannot create a credit note')) throw error(400, e.message);
		if (e.message.includes('Cannot set')) throw error(400, e.message);
		if (e.message.includes('not found')) throw error(404, e.message);
		if (e.message.includes('already in use')) throw error(409, e.message);
		if (e.message.includes('conflicts')) throw error(409, e.message);
	}
	throw e;
}
