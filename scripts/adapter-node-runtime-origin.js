import adapterNode from '@sveltejs/adapter-node';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN_EXPORT = /^export const origin = .*;$/m;

/**
 * SvelteKit 3 removed adapter-node's ORIGIN environment variable and moved
 * origin configuration to the build-time `kit.paths.origin` option. ITCake is
 * installed from source, so baking a public URL into the build would make
 * changing a domain (or testing on localhost) require a rebuild — and silently
 * use the wrong origin if .env changed afterwards.
 *
 * Replace the generated constant with a tiny runtime lookup. The application's
 * production startup checks still validate ORIGIN strictly and refuse to start
 * on an invalid value; this only restores the pre-v3 runtime contract.
 */
const RUNTIME_ORIGIN_EXPORT = `export const origin = (() => {
	const raw = process.env.ORIGIN?.trim();
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		if (
			(url.protocol !== 'http:' && url.protocol !== 'https:') ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== '/' ||
			raw.endsWith('/')
		) {
			return undefined;
		}
		return url.origin;
	} catch {
		return undefined;
	}
})();`;

/**
 * @param {string} source
 * @returns {string}
 */
export function patchRuntimeOrigin(source) {
	if (!ORIGIN_EXPORT.test(source)) {
		throw new Error(
			'[adapter] Could not find "export const origin = ...;" in build/adapter-node.js. ' +
			'The runner may have changed its generated output; update scripts/adapter-node-runtime-origin.js.'
		);
	}
	return source.replace(ORIGIN_EXPORT, RUNTIME_ORIGIN_EXPORT);
}

/**
 * @param {Parameters<typeof adapterNode>[0]} [options]
 */
export default function adapterNodeRuntimeOrigin(options = {}) {
	const inner = adapterNode(options);
	const out = options.out ?? 'build';

	return {
		...inner,
		/** @param {import('@sveltejs/kit').Builder} builder */
		async adapt(builder) {
			await inner.adapt(builder);
			const file = join(out, 'adapter-node.js');
			const source = readFileSync(file, 'utf8');
			writeFileSync(file, patchRuntimeOrigin(source));
		}
	};
}
