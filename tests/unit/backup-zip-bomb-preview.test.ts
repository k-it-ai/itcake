/**
 * Regression: previewRestore previously called JSZip.loadAsync with no
 * decompression-bomb scan — restoreBackup had a central-directory check
 * but the preview path didn't. The bomb-cap helper now lives at module
 * scope and both call sites use it; this test pins the shape so a future
 * refactor doesn't drop preview back to the unguarded path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('backups.ts: zip-bomb guard is applied in both restore and preview', () => {
	const src = readFileSync(path.resolve('src/services/backups.ts'), 'utf-8');

	it('defines the shared enforceZipBombCaps helper', () => {
		expect(src).toMatch(/function enforceZipBombCaps\(/);
	});

	it('previewRestore invokes enforceZipBombCaps after loadAsync', () => {
		const preview = src.slice(src.indexOf('export async function previewRestore'));
		expect(preview).toMatch(/JSZip\.loadAsync/);
		const loadIdx = preview.indexOf('JSZip.loadAsync');
		const enforceIdx = preview.indexOf('enforceZipBombCaps');
		expect(enforceIdx).toBeGreaterThan(loadIdx);
		expect(enforceIdx - loadIdx).toBeLessThan(200);
	});

	it('restoreBackup invokes enforceZipBombCaps after loadAsync', () => {
		const restore = src.slice(src.indexOf('export async function restoreBackup'));
		const loadIdx = restore.indexOf('JSZip.loadAsync');
		const enforceIdx = restore.indexOf('enforceZipBombCaps');
		expect(loadIdx).toBeGreaterThanOrEqual(0);
		expect(enforceIdx).toBeGreaterThan(loadIdx);
		expect(enforceIdx - loadIdx).toBeLessThan(200);
	});

	it('rejects backups whose central directory omits uncompressed sizes', () => {
		expect(src).toMatch(/central-directory metadata missing uncompressed sizes/);
	});
});
