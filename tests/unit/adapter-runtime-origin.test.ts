import { describe, it, expect } from 'vitest';
import {
	patchRuntimeOrigin
} from '../../scripts/adapter-node-runtime-origin.js';

const GENERATED = [
	"import { dirname } from 'node:path';",
	"export const dir = dirname('x');",
	'export const origin = undefined;',
	'export const env_prefix = "";'
].join('\n');

function runtimeExpression(patched: string): string {
	const match = patched.match(/export const origin = ([\s\S]*?);\nexport const env_prefix/);
	if (!match) throw new Error('patched runtime origin expression not found');
	return match[1];
}

function resolveOrigin(raw: string | undefined): string | undefined {
	const expression = runtimeExpression(patchRuntimeOrigin(GENERATED));
	// The generated code only uses Node globals; evaluate it in isolation so
	// the test asserts the exact text that ships in build/adapter-node.js.
	const fn = new Function('process', 'URL', `return (${expression});`);
	return fn({ env: { ORIGIN: raw } }, URL) as string | undefined;
}

describe('adapter-node runtime ORIGIN patch', () => {
	it('replaces the generated build-time constant', () => {
		const patched = patchRuntimeOrigin(GENERATED);
		expect(patched).not.toContain('export const origin = undefined;');
		expect(patched).toContain('process.env.ORIGIN');
		expect(patched).toContain("export const env_prefix = \"\";");
	});

	it('throws a clear error if the adapter output shape changes', () => {
		expect(() => patchRuntimeOrigin('export const dir = "/tmp";'))
			.toThrow(/Could not find "export const origin/);
	});

	it('resolves ORIGIN at runtime, including trailing-slash rejection', () => {
		expect(resolveOrigin(undefined)).toBeUndefined();
		expect(resolveOrigin('')).toBeUndefined();
		expect(resolveOrigin('https://invoices.example.com')).toBe('https://invoices.example.com');
		expect(resolveOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
		expect(resolveOrigin('https://invoices.example.com/')).toBeUndefined();
		expect(resolveOrigin('https://invoices.example.com/path')).toBeUndefined();
		expect(resolveOrigin('ftp://invoices.example.com')).toBeUndefined();
		expect(resolveOrigin('not a url')).toBeUndefined();
	});
});
