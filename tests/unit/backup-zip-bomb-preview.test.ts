/**
 * Regression: previewRestore previously called JSZip.loadAsync with no
 * decompression-bomb scan — restoreBackup had a central-directory check
 * but the preview path didn't. The bomb-cap helper now lives at module
 * scope and both call sites use it; this test pins the contract so a
 * future refactor doesn't drop preview back to the unguarded path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('backups.ts: zip-bomb guard is applied in both restore and preview', () => {
	const src = readFileSync(path.resolve('src/services/backups.ts'), 'utf-8');

	const sliceFn = (name: string): string => {
		const start = src.indexOf(`export async function ${name}`);
		if (start < 0) return '';
		const rest = src.slice(start + 1);
		const nextExport = rest.indexOf('\nexport ');
		return rest.slice(0, nextExport >= 0 ? nextExport : rest.length);
	};

	it('defines the shared enforceZipBombCaps helper', () => {
		expect(src).toMatch(/function enforceZipBombCaps\(/);
	});

	it('previewRestore invokes enforceZipBombCaps after loadAsync', () => {
		const fn = sliceFn('previewRestore');
		expect(fn).toMatch(/JSZip\.loadAsync/);
		expect(fn).toMatch(/enforceZipBombCaps/);
		expect(fn.indexOf('enforceZipBombCaps')).toBeGreaterThan(fn.indexOf('JSZip.loadAsync'));
	});

	it('restoreBackup invokes enforceZipBombCaps after loadAsync', () => {
		const fn = sliceFn('restoreBackup');
		expect(fn).toMatch(/JSZip\.loadAsync/);
		expect(fn).toMatch(/enforceZipBombCaps/);
		expect(fn.indexOf('enforceZipBombCaps')).toBeGreaterThan(fn.indexOf('JSZip.loadAsync'));
	});

	it('rejects backups whose central directory omits uncompressed sizes', () => {
		expect(src).toMatch(/central-directory metadata missing uncompressed sizes/);
	});
});
