/**
 * Monitor create/update validates that the target `domain` doesn't resolve
 * to a blocked IP range. The probe-time `resolveAndValidate` is still the
 * load-bearing check (DNS may change between create and probe), but this
 * stops the operator from saving an obviously-misconfigured monitor whose
 * every probe would be refused. Defense-in-depth.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-monitor-domain');

let validateMonitorTargets: typeof import('../../src/services/monitors.js').validateMonitorTargets;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'mon.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	validateMonitorTargets = (await import('../../src/services/monitors.js')).validateMonitorTargets;
});

describe('validateMonitorTargets — domain resolution check', () => {
	it('rejects IP literal in private range', async () => {
		await expect(validateMonitorTargets({ ip: '10.0.0.5' })).rejects.toThrow(/error.targetBlockedIpRange/);
	});

	it('rejects IP literal in loopback range', async () => {
		await expect(validateMonitorTargets({ ip: '127.0.0.1' })).rejects.toThrow(/error.targetBlockedIpRange/);
	});

	it('rejects AWS metadata IP literal', async () => {
		await expect(validateMonitorTargets({ ip: '169.254.169.254' })).rejects.toThrow(/error.targetBlockedIpRange/);
	});

	it('accepts an empty payload (nothing to validate)', async () => {
		await expect(validateMonitorTargets({})).resolves.toBeUndefined();
	});

	it('accepts an empty domain string', async () => {
		await expect(validateMonitorTargets({ domain: '   ' })).resolves.toBeUndefined();
	});

	it('accepts a public IP literal', async () => {
		await expect(validateMonitorTargets({ ip: '8.8.8.8' })).resolves.toBeUndefined();
	});

	it('tolerates DNS lookup failure (NXDOMAIN) without rejecting', async () => {
		// nonexistent.example.invalid — DNS will fail; we let it through so
		// internal-only-resolvable domains aren't blocked at config time.
		await expect(
			validateMonitorTargets({ domain: 'nonexistent.example.invalid' })
		).resolves.toBeUndefined();
	});
});
