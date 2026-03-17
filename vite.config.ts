import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import path from 'node:path';

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
