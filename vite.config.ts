import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Seed SESSION_SECRET before any module that reads it (field-crypto, agent-auth)
// is resolved. SvelteKit's env module snapshots process.env when Vite boots — a
// vitest setupFile runs too late. Doing it here guarantees the env is populated
// for both the dev server and the test runner.
if (!process.env.SESSION_SECRET) {
	process.env.SESSION_SECRET = randomBytes(32).toString('hex');
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Suppress state_referenced_locally: this codebase intentionally
				// copies $props() values into local $state for form editing
				// (settings pages, invoice/proposal detail). An $effect sync handler
				// re-syncs on invalidation.
				warningFilter: (w: { code: string }) => !w.code.startsWith('state_referenced_locally')
			},
			adapter: adapter({
				out: 'build',
				precompress: true
			}),
			csp: {
				directives: {
					'default-src': ['self'],
					// SvelteKit injects a per-request `'nonce-…'` source into
					// script-src/style-src itself — do not list a literal nonce here.
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:', 'blob:'],
					'font-src': ['self', 'data:'],
					// `'self'` covers same-origin wss: under the CSP3 'self'
					// extension that Chrome 49+, Firefox, and Safari all honor
					// for HTTPS documents. The Guacamole tunnel is same-origin
					// so we don't need a wildcard `wss:` (which would let a
					// stored-XSS payload exfiltrate to any wss:// host).
					'connect-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'frame-ancestors': ['self'],
					'form-action': ['self'],
					// Defense-in-depth: explicitly forbid worker/manifest/media/frame
					// surfaces the app doesn't use. CSP defaults inherit from
					// default-src but stating these wins audits and trips ZAP/Nessus
					// less often (they assume implicit defaults aren't enforced).
					'worker-src': ['none'],
					'manifest-src': ['self'],
					'media-src': ['none'],
					'frame-src': ['self'],
					'child-src': ['self']
				}
			}
		})
	],
	build: {
		sourcemap: false
	},
	server: {
		fs: {
			allow: [path.resolve('assets')]
		}
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node'
	}
});
