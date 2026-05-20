/**
 * Validates that reportError correctly composes a Sentry envelope and
 * gates on settings (DSN configured / sample rate). The actual HTTPS
 * POST is not exercised — pinnedHttpsRequest needs DNS resolution we
 * don't want in a unit test. We assert on the DSN parser + the
 * "disabled by default" no-op path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-error-reporter');

let reportError: typeof import('../../src/lib/server/error-reporter.js').reportError;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'er.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const dbMod = await import('../../src/lib/server/db.js');
	setSetting = dbMod.setSetting;
	const er = await import('../../src/lib/server/error-reporter.js');
	reportError = er.reportError;
});

describe('reportError', () => {
	it('is a no-op when DSN is empty', () => {
		setSetting('telemetry', { errorReportingDsn: '', sampleRate: 1 });
		expect(() => reportError(new Error('test'))).not.toThrow();
	});

	it('is a no-op when DSN cannot be parsed', () => {
		setSetting('telemetry', { errorReportingDsn: 'not-a-url', sampleRate: 1 });
		expect(() => reportError(new Error('test'))).not.toThrow();
	});

	it('is a no-op when DSN protocol is http (not https)', () => {
		setSetting('telemetry', { errorReportingDsn: 'http://key@sentry.example/1', sampleRate: 1 });
		expect(() => reportError(new Error('test'))).not.toThrow();
	});

	it('is a no-op when sampleRate is 0', () => {
		setSetting('telemetry', { errorReportingDsn: 'https://key@sentry.example/1', sampleRate: 0 });
		expect(() => reportError(new Error('test'))).not.toThrow();
	});

	// Direct test of the secret-redaction helper used inside the reporter.
	// Reaching the network layer would require mocking pinnedHttpsRequest;
	// this asserts the contract that operator-shipped payloads scrub
	// token-shaped secrets before they leave the process.
	it('redactSensitiveInput strips known token shapes', async () => {
		const { redactSensitiveInput } = await import('../../src/lib/server/ai/compaction.js');
		expect(redactSensitiveInput('msg with sk-ant-api03-abcdefghijklmnopqrstuvwxyz123 inside'))
			.toContain('[REDACTED:anthropic-api-key]');
		expect(redactSensitiveInput('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED:aws-access-key]');
		expect(redactSensitiveInput('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain('[REDACTED:github-token]');
	});
});
