import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import adapter from './scripts/adapter-node-runtime-origin.js';
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
					// Fallback only: src/hooks.server.ts sets the page CSP with an
					// explicit wss://${host} because CSP3's 'self' doesn't reliably
					// cover wss:. Never use a wildcard `wss:` here — it would let a
					// stored-XSS payload exfiltrate to any wss:// host.
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
	ssr: {
		// htmlparser2 is ESM-only. Keep it inside the server bundle so the
		// build never imports it while sanitize-html (CJS) is require()-ing
		// the same package from node_modules — Node 22 raises
		// ERR_REQUIRE_ESM_RACE_CONDITION for that dual load.
		noExternal: ['htmlparser2']
	},
	server: {
		fs: {
			allow: [path.resolve('assets')]
		}
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		// beforeAll hooks load + initialise the DB; the 10s default flakes
		// under a fully parallel suite on a loaded machine.
		hookTimeout: 30_000
	}
});
