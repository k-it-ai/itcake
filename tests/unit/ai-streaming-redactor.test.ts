/**
 * Streaming-secret redactor for AI text_delta SSE events. Without this,
 * a token-shaped secret echoed by the model — e.g., it summarized a tool
 * result containing a secret — would stream verbatim to the operator's
 * browser before the final-message redactor ran. This module hooks into
 * the SDK's `text` event so emit-time is also redact-time.
 */
import { describe, it, expect } from 'vitest';
import { StreamingRedactor, stripSecrets } from '../../src/lib/server/ai/compaction.js';

function pushChunks(chunks: string[]): { emits: string[]; final: string } {
	const r = new StreamingRedactor();
	const emits: string[] = [];
	const emit = (s: string) => emits.push(s);
	for (const c of chunks) r.push(c, emit);
	r.flush(emit);
	return { emits, final: emits.join('') };
}

describe('StreamingRedactor', () => {
	it('emits a complete short word only on flush (no token boundary)', () => {
		const { emits, final } = pushChunks(['hello']);
		expect(emits.length).toBe(1);
		expect(final).toBe('hello');
	});

	it('emits long plain text on word boundaries with no redaction', () => {
		const longText = 'word '.repeat(40); // 200 chars, lots of boundaries
		const { final } = pushChunks([longText]);
		expect(final).toBe(longText);
	});

	it('redacts a complete Anthropic key in a single delta', () => {
		const sneaky = 'The key is sk-ant-' + 'A'.repeat(30) + ' (do not share)';
		const { final } = pushChunks([sneaky]);
		expect(final).not.toContain('sk-ant-AAA');
		expect(final).toContain('[REDACTED:anthropic-api-key]');
	});

	it('redacts an Anthropic key split across many small deltas', () => {
		// Split "sk-ant-XXXXXXXXXXXXXXXXXXXXXXXXX" into 3-char chunks.
		const secret = 'sk-ant-' + 'B'.repeat(30);
		const chunks = [];
		for (let i = 0; i < secret.length; i += 3) chunks.push(secret.slice(i, i + 3));
		// Pad with text to push beyond TAIL_HOLD_CHARS.
		const { final } = pushChunks(['Prefix:', ...chunks, ' '.repeat(100)]);
		expect(final).not.toMatch(/sk-ant-B+/);
		expect(final).toContain('[REDACTED:anthropic-api-key]');
	});

	it('redacts an AWS access key spanning two deltas', () => {
		const secret = 'AKIA' + 'B'.repeat(16);
		// Split half and half — the boundary is right inside the secret.
		const a = 'see: ' + secret.slice(0, 10);
		const b = secret.slice(10) + ' end';
		const { final } = pushChunks([a, b, ' '.repeat(100)]);
		expect(final).not.toContain('AKIABB');
		expect(final).toContain('[REDACTED:aws-access-key]');
	});

	it('holds the trailing partial token until a boundary or flush', () => {
		// A long unbroken word (no spaces) — nothing is emitted until flush
		// because there's never a token boundary to commit on.
		const longClean = 'x'.repeat(200);
		const r = new StreamingRedactor();
		const incremental: string[] = [];
		r.push(longClean, s => incremental.push(s));
		expect(incremental.join('')).toBe('');
		r.flush(s => incremental.push(s));
		expect(incremental.join('')).toBe(longClean);
	});

	it('holds the entire buffer for PEM private key until END marker', () => {
		const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVwIB...\n-----END PRIVATE KEY-----';
		const r = new StreamingRedactor();
		const out: string[] = [];
		r.push('Before. ', s => out.push(s));
		r.push(pem.slice(0, 30), s => out.push(s));
		// Mid-PEM — nothing should emit (we are holding all).
		const midState = out.join('');
		expect(midState).not.toContain('-----BEGIN');
		r.push(pem.slice(30), s => out.push(s));
		// Now END marker is present — emit happens.
		r.flush(s => out.push(s));
		const final = out.join('');
		expect(final).toContain('[REDACTED:pem-private-key]');
		expect(final).not.toContain('MIIBVwIB');
	});

	it('flush is a no-op when buffer is empty', () => {
		const r = new StreamingRedactor();
		const out: string[] = [];
		r.flush(s => out.push(s));
		expect(out.length).toBe(0);
	});

	it('respects multi-call .push semantics (round-trip equals stripSecrets of concat)', () => {
		const chunks = [
			'Operator gave key ',
			'gh',
			'p_',
			'A'.repeat(25),
			' for the test, ',
			'AKIA',
			'X'.repeat(16),
			' was the second.'
		];
		const { final } = pushChunks(chunks);
		const expected = stripSecrets(chunks.join(''));
		expect(final).toBe(expected);
	});

	it('does not leak when a secret appears at the very end without trailing text', () => {
		const secret = 'sk-ant-' + 'Z'.repeat(30);
		const { final } = pushChunks(['preamble ', secret]);
		expect(final).not.toContain('sk-ant-Z');
		expect(final).toContain('[REDACTED:anthropic-api-key]');
	});
});
