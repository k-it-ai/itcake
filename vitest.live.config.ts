import { defineConfig } from 'vitest/config';
import base from './vite.config.js';

const baseConfig = base as Record<string, unknown> & { test?: Record<string, unknown> };

// Opt-in live suite. Unlike the default hermetic suite, these tests boot the
// production artifact and drive real external surfaces (Chromium, Caddy, the
// Go agent binary, Ethereal SMTP, Telegram/Anthropic APIs). They may skip when
// the required binary or credential is absent.
export default defineConfig({
	...baseConfig,
	test: {
		...(baseConfig.test ?? {}),
		include: ['tests/live/**/*.test.ts'],
		// These tests bind fixed ports, launch Chromium/Caddy, and run the Go
		// agent. Running them sequentially keeps ports and resources
		// deterministic; they're opt-in, so the extra wall time is acceptable.
		fileParallelism: false
	}
});
