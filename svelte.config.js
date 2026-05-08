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
				// `wss:` is needed for the Guacamole WebSocket tunnel; CSP3 says
				// 'self' covers same-origin wss: when the document is HTTPS, but
				// browsers differ on enforcement — name the scheme explicitly.
				'connect-src': ['self', 'wss:'],
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
	}
};

export default config;
