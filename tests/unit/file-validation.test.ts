/**
 * Pure-unit tests for `verifyMagicBytes` — the magic-byte gate that backs
 * every file-upload route (logo, receipts, restore-backup zip). The
 * promise is: declared mime must match the actual signature, and SVG /
 * exotic types are rejected by absence from the table.
 */
import { describe, it, expect } from 'vitest';
import { verifyMagicBytes } from '../../src/lib/server/file-validation.js';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_HEADER = Buffer.concat([
	Buffer.from([0x52, 0x49, 0x46, 0x46]),
	Buffer.from([0x00, 0x00, 0x00, 0x00]),
	Buffer.from([0x57, 0x45, 0x42, 0x50])
]);
const PDF_HEADER = Buffer.from('%PDF-1.4');
const SVG_BODY = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe('verifyMagicBytes', () => {
	it('accepts valid PNG header for image/png', () => {
		expect(verifyMagicBytes(PNG_HEADER, 'image/png')).toBe(true);
	});

	it('accepts valid JPEG header for image/jpeg', () => {
		expect(verifyMagicBytes(JPEG_HEADER, 'image/jpeg')).toBe(true);
	});

	it('accepts valid WebP container (RIFF + WEBP at offset 8)', () => {
		expect(verifyMagicBytes(WEBP_HEADER, 'image/webp')).toBe(true);
	});

	it('rejects RIFF container without WEBP fourcc (.wav etc.)', () => {
		const riffWav = Buffer.concat([
			Buffer.from([0x52, 0x49, 0x46, 0x46]),
			Buffer.from([0x00, 0x00, 0x00, 0x00]),
			Buffer.from([0x57, 0x41, 0x56, 0x45])
		]);
		expect(verifyMagicBytes(riffWav, 'image/webp')).toBe(false);
	});

	it('accepts valid PDF header for application/pdf', () => {
		expect(verifyMagicBytes(PDF_HEADER, 'application/pdf')).toBe(true);
	});

	it('rejects PNG header declared as JPEG (mime/content mismatch)', () => {
		expect(verifyMagicBytes(PNG_HEADER, 'image/jpeg')).toBe(false);
	});

	it('rejects JPEG header declared as PNG (mime/content mismatch)', () => {
		expect(verifyMagicBytes(JPEG_HEADER, 'image/png')).toBe(false);
	});

	it('rejects SVG content for any declared image type — SVG is not in the table', () => {
		expect(verifyMagicBytes(SVG_BODY, 'image/svg+xml')).toBe(false);
		expect(verifyMagicBytes(SVG_BODY, 'image/png')).toBe(false);
		expect(verifyMagicBytes(SVG_BODY, 'image/jpeg')).toBe(false);
	});

	it('rejects unknown declared mime types', () => {
		expect(verifyMagicBytes(PNG_HEADER, 'application/x-evil')).toBe(false);
		expect(verifyMagicBytes(PNG_HEADER, 'text/html')).toBe(false);
	});

	it('rejects buffers shorter than the signature', () => {
		expect(verifyMagicBytes(Buffer.from([0x89, 0x50]), 'image/png')).toBe(false);
		expect(verifyMagicBytes(Buffer.alloc(0), 'image/png')).toBe(false);
	});

	it('rejects WebP with truncated container (RIFF prefix but no fourcc)', () => {
		const truncated = Buffer.concat([
			Buffer.from([0x52, 0x49, 0x46, 0x46]),
			Buffer.from([0x00, 0x00, 0x00, 0x00])
		]);
		expect(verifyMagicBytes(truncated, 'image/webp')).toBe(false);
	});
});
