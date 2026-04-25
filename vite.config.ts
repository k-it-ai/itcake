import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Seed SESSION_SECRET before any module that reads it (field-crypto, agent-auth)
// is resolved. SvelteKit's `$env/dynamic/private` snapshots process.env when
// Vite boots — a vitest setupFile runs too late. Doing it here guarantees
// the env is populated for both the dev server and the test runner.
if (!process.env.SESSION_SECRET) {
	process.env.SESSION_SECRET = randomBytes(32).toString('hex');
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
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
