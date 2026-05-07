import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { diffAgainstBaseline, type NetworkResult, type NetworkDevice } from '../../src/services/network-baseline.js';

const TEST_DIR = path.resolve('data-test-network-baseline-diff');

let validateNetworkScanOptions: typeof import('../../src/services/network-baseline.js').validateNetworkScanOptions;
let processNetworkDiscoveryResult: typeof import('../../src/services/network-baseline.js').processNetworkDiscoveryResult;
let processNetworkBaselineCompare: typeof import('../../src/services/network-baseline.js').processNetworkBaselineCompare;
let setNetworkBaseline: typeof import('../../src/services/network-baseline.js').setNetworkBaseline;
let listFindingsByCategory: typeof import('../../src/services/agent-findings.js').listFindingsByCategory;
let getLatestCollectorResult: typeof import('../../src/services/agent-collector-results.js').getLatestCollectorResult;
let validateCommandPayload: typeof import('../../src/lib/validators-rmm.js').validateCommandPayload;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'net.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const mod = await import('../../src/services/network-baseline.js');
	const fmod = await import('../../src/services/agent-findings.js');
	const cmod = await import('../../src/services/agent-collector-results.js');
	const vmod = await import('../../src/lib/validators-rmm.js');
	const dbMod = await import('../../src/lib/server/db.js');
	validateNetworkScanOptions = mod.validateNetworkScanOptions;
	processNetworkDiscoveryResult = mod.processNetworkDiscoveryResult;
	processNetworkBaselineCompare = mod.processNetworkBaselineCompare;
	setNetworkBaseline = mod.setNetworkBaseline;
	listFindingsByCategory = fmod.listFindingsByCategory;
	getLatestCollectorResult = cmod.getLatestCollectorResult;
	validateCommandPayload = vmod.validateCommandPayload;
	db = dbMod.db;

	db.prepare(`DELETE FROM agents WHERE id IN ('n-1', 'n-2')`).run();
	db.prepare(`DELETE FROM agents WHERE token_hash IN ('tk-n-1', 'tk-n-2')`).run();
	db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('n-1', 'n-1', 'n-1', 'linux', 'amd64', 'tk-n-1')`).run();
	db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('n-2', 'n-2', 'n-2', 'linux', 'amd64', 'tk-n-2')`).run();
});

const dev = (over: Partial<NetworkDevice> = {}): NetworkDevice => ({
	ip: '192.168.1.10',
	mac: 'aa:bb:cc:dd:ee:ff',
	hostname: 'host-a',
	openPorts: [],
	vendor: '',
	lastSeen: '',
	...over
});

const scan = (devices: NetworkDevice[]): NetworkResult => ({
	scannedAt: '2026-05-06T18:00:00Z',
	durationSeconds: 12,
	subnetsScanned: ['192.168.1.0/24'],
	methodsUsed: ['arp', 'ping'],
	devices,
	truncated: false,
	errors: []
});

describe('diffAgainstBaseline', () => {
	it('flags a device whose IP+MAC are absent from the baseline', () => {
		const baseline = [dev({ ip: '192.168.1.10' })];
		const current = scan([dev({ ip: '192.168.1.10' }), dev({ ip: '192.168.1.50', mac: '11:22:33:44:55:66', hostname: 'new' })]);
		const out = diffAgainstBaseline(current, baseline);
		expect(out.newDevices.length).toBe(1);
		expect(out.newDevices[0].ip).toBe('192.168.1.50');
		expect(out.disappeared.length).toBe(0);
		expect(out.changed.length).toBe(0);
	});

	it('flags a baseline device that is missing AND was last seen > 24h ago', () => {
		const baseline = [
			dev({ ip: '192.168.1.10' }),
			dev({ ip: '192.168.1.99', mac: '99:99:99:99:99:99', lastSeen: '2026-05-04T00:00:00Z' })
		];
		const now = new Date('2026-05-06T18:00:00Z');
		const current = scan([dev({ ip: '192.168.1.10' })]);
		const out = diffAgainstBaseline(current, baseline, now);
		expect(out.disappeared.length).toBe(1);
		expect(out.disappeared[0].ip).toBe('192.168.1.99');
	});

	it('does NOT flag a missing baseline device whose lastSeen is within 24h', () => {
		const baseline = [
			dev({ ip: '192.168.1.10' }),
			dev({ ip: '192.168.1.99', mac: '99:99:99:99:99:99', lastSeen: '2026-05-06T12:00:00Z' })
		];
		const now = new Date('2026-05-06T18:00:00Z');
		const current = scan([dev({ ip: '192.168.1.10' })]);
		const out = diffAgainstBaseline(current, baseline, now);
		expect(out.disappeared.length).toBe(0);
	});

	it('flags a hostname change for a device matched by MAC', () => {
		const baseline = [dev({ ip: '192.168.1.10', hostname: 'host-a' })];
		const current = scan([dev({ ip: '192.168.1.10', hostname: 'host-b' })]);
		const out = diffAgainstBaseline(current, baseline);
		expect(out.changed.length).toBe(1);
		expect(out.changed[0].reason).toContain('hostname_changed');
	});

	it('flags a MAC change on the same IP', () => {
		const baseline = [dev({ ip: '192.168.1.10', mac: 'aa:aa:aa:aa:aa:aa' })];
		const current = scan([dev({ ip: '192.168.1.10', mac: 'bb:bb:bb:bb:bb:bb' })]);
		const out = diffAgainstBaseline(current, baseline);
		// Different MAC → different deviceKey → looks like a new device + a
		// disappeared baseline entry; that's the right behaviour for "device
		// at this IP changed identity". The test pins the contract.
		expect(out.newDevices.length).toBe(1);
		expect(out.disappeared.length).toBe(1);
	});

	it('matches the same physical device across IP changes via MAC', () => {
		const baseline = [dev({ ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'host-a' })];
		const current = scan([dev({ ip: '192.168.1.55', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'host-a' })]);
		const out = diffAgainstBaseline(current, baseline);
		expect(out.newDevices.length).toBe(0);
		expect(out.disappeared.length).toBe(0);
		expect(out.changed.length).toBe(0);
	});
});

describe('validateNetworkScanOptions', () => {
	it('applies defaults for empty input', () => {
		const o = validateNetworkScanOptions({});
		expect(o.timeoutSeconds).toBe(30);
		expect(o.concurrency).toBe(32);
		expect(o.portTopN).toBe(12);
		expect(o.subnets).toEqual([]);
		expect(o.methods.length).toBe(4);
	});

	it('accepts valid CIDRs', () => {
		const o = validateNetworkScanOptions({ subnets: ['10.0.0.0/24', '192.168.1.0/24'] });
		expect(o.subnets.length).toBe(2);
	});

	it('rejects invalid CIDR', () => {
		expect(() => validateNetworkScanOptions({ subnets: ['not-a-cidr'] })).toThrow();
	});

	it('rejects out-of-range concurrency', () => {
		expect(() => validateNetworkScanOptions({ concurrency: 0 })).toThrow();
		expect(() => validateNetworkScanOptions({ concurrency: 9999 })).toThrow();
	});

	it('rejects out-of-range portTopN', () => {
		expect(() => validateNetworkScanOptions({ portTopN: 0 })).toThrow();
		expect(() => validateNetworkScanOptions({ portTopN: 999 })).toThrow();
	});
});

describe('baseline lifecycle', () => {
	it('processNetworkDiscoveryResult records the snapshot', () => {
		const r = processNetworkDiscoveryResult('cmd-n-a', 'n-1', {
			scannedAt: new Date().toISOString(),
			durationSeconds: 4,
			subnetsScanned: ['10.0.0.0/24'],
			methodsUsed: ['arp', 'ping'],
			devices: [
				{ ip: '10.0.0.1', mac: 'aa:bb:cc:dd:ee:01', hostname: 'router', openPorts: [], vendor: '', lastSeen: '' },
				{ ip: '10.0.0.2', mac: 'aa:bb:cc:dd:ee:02', hostname: 'pi', openPorts: [22], vendor: '', lastSeen: '' }
			],
			truncated: false,
			errors: []
		});
		expect(r.devicesRecorded).toBe(2);
		const latest = getLatestCollectorResult('n-1', 'network_discovery');
		expect(latest).not.toBeNull();
	});

	it('setNetworkBaseline copies latest discovery into the baseline kind', () => {
		const out = setNetworkBaseline('n-1', 'user-1');
		expect(out.devices).toBe(2);
		const baseline = getLatestCollectorResult('n-1', 'network_baseline');
		expect(baseline).not.toBeNull();
		const baselineDevices = (baseline!.payload as { devices: unknown[] }).devices;
		expect(Array.isArray(baselineDevices)).toBe(true);
		expect(baselineDevices.length).toBe(2);
	});

	it('compare emits findings for new + changed devices', () => {
		const before = listFindingsByCategory('n-1', 'network', 200).length;
		const r = processNetworkBaselineCompare('cmd-n-b', 'n-1', {
			scannedAt: new Date().toISOString(),
			durationSeconds: 5,
			subnetsScanned: ['10.0.0.0/24'],
			methodsUsed: ['arp', 'ping'],
			devices: [
				{ ip: '10.0.0.1', mac: 'aa:bb:cc:dd:ee:01', hostname: 'router-renamed', openPorts: [], vendor: '', lastSeen: '' },
				{ ip: '10.0.0.2', mac: 'aa:bb:cc:dd:ee:02', hostname: 'pi', openPorts: [22], vendor: '', lastSeen: '' },
				{ ip: '10.0.0.99', mac: 'de:ad:be:ef:00:01', hostname: 'rogue', openPorts: [], vendor: '', lastSeen: '' }
			],
			truncated: false,
			errors: []
		});
		expect(r.findingsEmitted).toBeGreaterThanOrEqual(2);
		const after = listFindingsByCategory('n-1', 'network', 200).length;
		expect(after).toBeGreaterThan(before);
		const newDevFindings = listFindingsByCategory('n-1', 'network', 200).filter(f => (f.evidence as { kind?: string }).kind === 'new_device');
		expect(newDevFindings.some(f => ((f.evidence as { device?: { ip?: string } }).device)?.ip === '10.0.0.99')).toBe(true);
	});

	it('repeat compare with same scan does NOT add new finding rows (fingerprint dedup)', () => {
		const before = listFindingsByCategory('n-1', 'network', 200).length;
		processNetworkBaselineCompare('cmd-n-c', 'n-1', {
			scannedAt: new Date().toISOString(),
			durationSeconds: 5,
			subnetsScanned: ['10.0.0.0/24'],
			methodsUsed: ['arp'],
			devices: [
				{ ip: '10.0.0.1', mac: 'aa:bb:cc:dd:ee:01', hostname: 'router-renamed', openPorts: [], vendor: '', lastSeen: '' },
				{ ip: '10.0.0.2', mac: 'aa:bb:cc:dd:ee:02', hostname: 'pi', openPorts: [22], vendor: '', lastSeen: '' },
				{ ip: '10.0.0.99', mac: 'de:ad:be:ef:00:01', hostname: 'rogue', openPorts: [], vendor: '', lastSeen: '' }
			],
			truncated: false,
			errors: []
		});
		const after = listFindingsByCategory('n-1', 'network', 200).length;
		expect(after).toBe(before);
	});

	it('compare without baseline records snapshot but emits no findings', () => {
		const before = listFindingsByCategory('n-2', 'network', 200).length;
		const r = processNetworkBaselineCompare('cmd-n-d', 'n-2', {
			scannedAt: new Date().toISOString(),
			durationSeconds: 1,
			subnetsScanned: [],
			methodsUsed: [],
			devices: [
				{ ip: '10.0.0.50', mac: 'aa:bb:cc:11:22:33', hostname: '', openPorts: [], vendor: '', lastSeen: '' }
			],
			truncated: false,
			errors: []
		});
		expect(r.findingsEmitted).toBe(0);
		const after = listFindingsByCategory('n-2', 'network', 200).length;
		expect(after).toBe(before);
	});

	it('rejects malformed payload silently', () => {
		const r = processNetworkDiscoveryResult('cmd-n-e', 'n-1', { devices: 'not-an-array' } as Record<string, unknown>);
		expect(r.devicesRecorded).toBe(0);
	});
});

describe('validateCommandPayload (network types)', () => {
	it('accepts empty opts (auto-detect)', () => {
		const r = validateCommandPayload('network_discovery', {});
		expect(r.ok).toBe(true);
	});

	it('accepts valid CIDR opts', () => {
		const r = validateCommandPayload('network_discovery', { opts: { subnets: ['10.0.0.0/24'], concurrency: 64, portTopN: 20 } });
		expect(r.ok).toBe(true);
	});

	it('rejects invalid CIDR opts', () => {
		const r = validateCommandPayload('network_discovery', { opts: { subnets: ['nonsense'] } });
		expect(r.ok).toBe(false);
	});

	it('rejects out-of-range concurrency', () => {
		const r = validateCommandPayload('network_baseline_compare', { opts: { concurrency: 9999 } });
		expect(r.ok).toBe(false);
	});

	it('rejects unknown method', () => {
		const r = validateCommandPayload('network_discovery', { opts: { methods: ['arp', 'wizardry'] } });
		expect(r.ok).toBe(false);
	});
});
