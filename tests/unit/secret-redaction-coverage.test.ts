/**
 * Regression for secret-regex coverage in tool-result compaction.
 *
 * Before this fix, GitHub fine-grained PATs (`github_pat_…`) and AWS
 * temporary access keys (`ASIA…`) passed through compactToolResultForChat
 * unredacted, so a tool that surfaced one in stdout would leak the
 * credential back into the model's context (and the audit row).
 */
import { describe, it, expect, beforeAll } from 'vitest';

type Compaction = typeof import('../../src/lib/server/ai/compaction.js');

describe('compactToolResultForChat: secret redaction', () => {
	let compact: Compaction['compactToolResultForChat'];

	beforeAll(async () => {
		const mod = await import('../../src/lib/server/ai/compaction.js');
		compact = mod.compactToolResultForChat;
	});

	it('redacts GitHub fine-grained PATs', () => {
		const pat = 'github_pat_' + 'a'.repeat(82);
		const out = compact({ stdout: `token=${pat}` });
		expect(out.json).not.toContain(pat);
		expect(out.json).toContain('[REDACTED:github-fine-grained-token]');
	});

	it('redacts AWS temporary access keys (ASIA prefix)', () => {
		const key = 'ASIAABCDEFGHIJKLMNOP';
		const out = compact({ stdout: `AWS_ACCESS_KEY_ID=${key}` });
		expect(out.json).not.toContain(key);
		expect(out.json).toContain('[REDACTED:aws-temp-access-key]');
	});

	it('still redacts pre-existing patterns (regression: AKIA, sk-ant, ghp_)', () => {
		const out = compact({
			a: 'AKIAABCDEFGHIJKLMNOP',
			b: 'sk-ant-' + 'x'.repeat(40),
			c: 'ghp_' + 'y'.repeat(36)
		});
		expect(out.json).not.toContain('AKIAABCDEFGHIJKLMNOP');
		expect(out.json).not.toContain('sk-ant-');
		expect(out.json).not.toContain('ghp_');
		expect(out.json).toContain('[REDACTED:aws-access-key]');
		expect(out.json).toContain('[REDACTED:anthropic-api-key]');
		expect(out.json).toContain('[REDACTED:github-token]');
	});
});
