import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Suppress state_referenced_locally: this codebase intentionally copies
		// $props() values into local $state for form editing (settings pages,
		// invoice/proposal detail). An $effect sync handler re-syncs on invalidation.
		warningFilter: (w) => !w.code.startsWith('state_referenced_locally')
	},
	kit: {
		adapter: adapter({
			out: 'build',
			precompress: true
		}),
		alias: {
			$services: 'src/services',
			$components: 'src/components',
			$assets: 'assets'
		},
		csp: {
			directives: {
				'default-src': ['self'],
				'script-src': ['self', 'nonce'],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:', 'blob:'],
				'font-src': ['self', 'data:'],
				'connect-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'frame-ancestors': ['self'],
				'form-action': ['self']
			}
		}
	}
};

export default config;
