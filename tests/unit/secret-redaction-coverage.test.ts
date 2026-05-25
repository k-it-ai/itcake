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

	it('redacts GitLab personal access tokens', () => {
		const token = 'glpat-' + 'x'.repeat(24);
		const out = compact({ stdout: `GITLAB_TOKEN=${token}` });
		expect(out.json).not.toContain(token);
		expect(out.json).toContain('[REDACTED:gitlab-pat]');
	});

	it('redacts Docker Hub personal access tokens', () => {
		const token = 'dckr_pat_' + 'y'.repeat(28);
		const out = compact({ stdout: `DOCKER_TOKEN=${token}` });
		expect(out.json).not.toContain(token);
		expect(out.json).toContain('[REDACTED:docker-hub-token]');
	});

	it('redacts Notion integration tokens', () => {
		const token = 'secret_' + 'a'.repeat(43);
		const out = compact({ stdout: `NOTION=${token}` });
		expect(out.json).not.toContain(token);
		expect(out.json).toContain('[REDACTED:notion-token]');
	});

	it('redacts Slack workspace refresh tokens (xoxe- prefix)', () => {
		const token = 'xoxe-' + 'a'.repeat(40);
		const out = compact({ stdout: `SLACK_REFRESH=${token}` });
		expect(out.json).not.toContain(token);
		expect(out.json).toContain('[REDACTED:slack-bot-token]');
	});

	it('redacts Slack rotated access tokens (xoxe.xoxp- / xoxe.xoxb-)', () => {
		const p = 'xoxe.xoxp-' + 'b'.repeat(40);
		const b = 'xoxe.xoxb-' + 'c'.repeat(40);
		const out = compact({ user: p, bot: b });
		expect(out.json).not.toContain(p);
		expect(out.json).not.toContain(b);
		expect(out.json).toContain('[REDACTED:slack-rotated-access-token]');
	});
});
