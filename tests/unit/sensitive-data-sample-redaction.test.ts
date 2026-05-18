/**
 * Regression: agent-side SanitizeSample (patterns.go) and server-side
 * sanitizeSample (sensitive-data.ts) previously digit-masked only
 * pii_ssn and pci_card_number. AWS keys, PEM headers, secret-assignment
 * RHS values, IBANs, and email addresses passed through raw — landing
 * unredacted in agent_findings.evidence.sample where operators (and
 * exports / audit log) could read them.
 *
 * This test pins the server-side defensive scrub. The agent-side
 * sanitizer is covered by the Go test suite.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('sensitive-data sample sanitisation (server-side defence)', () => {
	const src = readFileSync(path.resolve('src/services/sensitive-data.ts'), 'utf-8');

	it('declares a sanitizeSample helper applied per pattern', () => {
		expect(src).toMatch(/function sanitizeSample\(/);
	});

	it('processSensitiveScanResult uses sanitizeSample, not truncateSample, in evidence', () => {
		const fn = src.slice(src.indexOf('export function processSensitiveScanResult'));
		expect(fn).toMatch(/sample:\s*sanitizeSample\(/);
		expect(fn).not.toMatch(/sample:\s*truncateSample\(/);
	});

	it('redacts AWS access keys, private keys, secret assignments, IBANs, emails', () => {
		expect(src).toMatch(/case 'credential_aws_access_key'/);
		expect(src).toMatch(/case 'credential_private_key'/);
		expect(src).toMatch(/case 'credential_secret_assignment'/);
		expect(src).toMatch(/case 'financial_iban'/);
		expect(src).toMatch(/case 'pii_email'/);
	});

	const goSrc = readFileSync(path.resolve('agent/internal/secscan/patterns.go'), 'utf-8');

	it('Go-side SanitizeSample covers the same six classes', () => {
		expect(goSrc).toMatch(/case "credential_aws_access_key":/);
		expect(goSrc).toMatch(/case "credential_private_key":/);
		expect(goSrc).toMatch(/case "credential_secret_assignment":/);
		expect(goSrc).toMatch(/case "financial_iban":/);
		expect(goSrc).toMatch(/case "pii_email":/);
	});
});
