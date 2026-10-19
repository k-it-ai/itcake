/**
 * Regression for security-review finding #6 (Medium):
 *   `services/ai-session.ts` previously stored the redacted input in the
 *   audit row but passed the un-redacted input to the tool handler. The
 *   operator approved a redacted view; the handler ran on the real value.
 *   Fix: pass `redactedInput` to `tool.handler`, so the handler operates on
 *   the same value the operator + auditor saw.
 *
 *   This is a source-shape regression test — the audit-trace property is
 *   load-bearing across multiple files (postMessage + audit row + SSE) and
 *   the easiest tamper-resistant assertion is "the call site stayed
 *   correct." If a future refactor renames `redactedInput` or reorders the
 *   block, this fails loudly.
 *
 *   `redactSensitiveInput` itself is covered by security-fixes.test.ts
 *   (E11 / E3).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('postMessage passes redactedInput to tool.handler (finding #6)', () => {
	const src = readFileSync(path.resolve('src/services/ai-session.ts'), 'utf-8');

	it('the handler call site uses redactedInput, not tu.input', () => {
		expect(src).toMatch(/tool\.handler\s*\(\s*redactedInput\b/);
	});

	it('does NOT pass tu.input directly to the handler', () => {
		// Negative case: any call shape that bypasses redaction would
		// re-introduce the gap finding #6 closed.
		expect(src).not.toMatch(/tool\.handler\s*\(\s*\(\s*tu\.input\s*\?\?/);
		expect(src).not.toMatch(/tool\.handler\s*\(\s*tu\.input\b/);
	});

	it('audit row uses the same redactedInput for tool_input', () => {
		expect(src).toMatch(/JSON\.stringify\(redactedInput\)/);
	});
});
