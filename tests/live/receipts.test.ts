/**
 * Live receipt upload test (§16).
 *
 * The hermetic suite checks `verifyMagicBytes` in isolation and the lifecycle
 * suite only asserts that the upload action does not 500. This test drives the
 * real production server over real multipart requests and verifies the bytes
 * that actually land on disk and come back from `/api/receipts`:
 *
 *   - a valid PNG is saved and downloaded byte-for-byte
 *   - a GIF renamed `.png` is rejected by magic bytes and does not replace it
 *   - SVG is rejected by the MIME allowlist
 *   - a file over the 10 MB cap is rejected
 *   - a traversal filename is ignored (the server names the file itself)
 *   - the download endpoint rejects traversal and unauthenticated reads
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
	startProductionServer, freshDataDir, cleanupDir, setupAdmin, formAction,
	jsonCall, type LiveServer
} from './helpers';

const PORT = 5509;
const DATA_DIR = freshDataDir('receipts');
const RECEIPT_DIR = path.join(DATA_DIR, 'uploads', 'receipts');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VALID_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from('itcake-live-receipt-body')]);
const GIF_BYTES = Buffer.from('GIF89a-not-really-a-png');
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let server: LiveServer;
let cookie: string;
let expenseId: string;

function upload(file: Buffer, filename: string, type: string): Promise<Response> {
	const form = new FormData();
	form.set('id', expenseId);
	form.set('date', '2026-10-28');
	form.set('description', 'Live receipt upload');
	form.set('amount', '1234');
	form.set('taxAmount', '197');
	form.set('currency', 'EUR');
	form.set('category', 'equipment');
	form.set('vendor', 'Live Test Vendor');
	form.set('notes', '');
	// Copy into a fresh Uint8Array so the BlobPart type is backed by a plain
	// ArrayBuffer (Buffer's ArrayBufferLike includes SharedArrayBuffer).
	const bytes = new Uint8Array(file.byteLength);
	bytes.set(file);
	form.set('receipt', new Blob([bytes], { type }), filename);
	return fetch(`${server.base}/expenses?/update`, {
		method: 'POST',
		headers: { Origin: server.origin, Cookie: cookie },
		body: form,
		redirect: 'manual'
	});
}

async function bodyText(res: Response): Promise<string> {
	return await res.text();
}

beforeAll(async () => {
	server = await startProductionServer({ port: PORT, dataDir: DATA_DIR });
	cookie = await setupAdmin(server, 'receipts@livetest.example');

	const created = await formAction(server, '/expenses', 'create', {
		date: '2026-10-28',
		description: 'Live receipt upload',
		amount: '1234',
		taxAmount: '197',
		currency: 'EUR',
		category: 'equipment',
		vendor: 'Live Test Vendor',
		notes: ''
	}, { cookie });
	expect(created.status).toBe(200);

	const search = await jsonCall(server, 'GET', '/api/search?q=Live+receipt+upload', undefined, { cookie });
	const results = search.data as unknown as Array<Record<string, unknown>>;
	const expense = results.find(r => r.type === 'expense');
	expect(expense, 'created expense not found via /api/search').toBeTruthy();
	expenseId = String(expense!.id);
}, 120_000);

afterAll(async () => {
	await server?.stop();
	cleanupDir(DATA_DIR);
});

describe('receipt uploads through the production server', () => {
	it('saves a valid PNG and serves it back byte-for-byte', async () => {
		const res = await upload(VALID_PNG, 'receipt.png', 'image/png');
		expect(res.status).toBe(200);
		expect(await bodyText(res)).not.toContain('receiptError');

		const filePath = path.join(RECEIPT_DIR, `${expenseId}.png`);
		expect(existsSync(filePath)).toBe(true);
		expect(statSync(filePath).mode & 0o777).toBe(0o600);

		const download = await fetch(`${server.base}/api/receipts?file=${expenseId}.png`, {
			headers: { Cookie: cookie }
		});
		expect(download.status).toBe(200);
		expect(download.headers.get('content-type')).toBe('image/png');
		expect(download.headers.get('cache-control')).toBe('private, no-store');
		const bytes = Buffer.from(await download.arrayBuffer());
		expect(bytes.equals(VALID_PNG)).toBe(true);
	});

	it('rejects a GIF renamed .png and keeps the previous receipt', async () => {
		const res = await upload(GIF_BYTES, 'evil.png', 'image/png');
		expect(res.status).toBe(200);
		expect((await bodyText(res)).toLowerCase()).toContain('does not match');

		const download = await fetch(`${server.base}/api/receipts?file=${expenseId}.png`, {
			headers: { Cookie: cookie }
		});
		expect(download.status).toBe(200);
		expect(Buffer.from(await download.arrayBuffer()).equals(VALID_PNG)).toBe(true);
	});

	it('rejects SVG by the MIME allowlist', async () => {
		const res = await upload(SVG_BYTES, 'evil.svg', 'image/svg+xml');
		expect(res.status).toBe(200);
		expect((await bodyText(res)).toLowerCase()).toContain('invalid file type');
	});

	it('rejects a file over the 10 MB cap', async () => {
		const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
		PNG_SIGNATURE.copy(oversized);
		const res = await upload(oversized, 'huge.png', 'image/png');
		// SvelteKit rejects an oversized multipart body with 413 before the
		// action runs; the action's own 10 MB check is the defense-in-depth
		// path for requests that reach it. Either is a valid rejection.
		expect([200, 413]).toContain(res.status);
		if (res.status === 200) {
			expect((await bodyText(res)).toLowerCase()).toContain('too large');
		}
	}, 30_000);

	it('ignores a traversal filename and stores a flat server-chosen name', async () => {
		const res = await upload(VALID_PNG, '../../etc/passwd.png', 'image/png');
		expect(res.status).toBe(200);
		expect(await bodyText(res)).not.toContain('receiptError');

		expect(existsSync(path.join(RECEIPT_DIR, `${expenseId}.png`))).toBe(true);
		expect(existsSync(path.join(DATA_DIR, 'uploads', 'etc', 'passwd.png'))).toBe(false);
	});

	it('rejects traversal and unauthenticated receipt downloads', async () => {
		const traversal = await fetch(`${server.base}/api/receipts?file=../../etc/passwd.png`, {
			headers: { Cookie: cookie }
		});
		expect([400, 404]).toContain(traversal.status);

		const anonymous = await fetch(`${server.base}/api/receipts?file=${expenseId}.png`);
		expect(anonymous.status).toBe(401);
	});
});
