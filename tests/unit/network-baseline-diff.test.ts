import { describe, it, expect } from 'vitest';
import { diffAgainstBaseline, type NetworkResult, type NetworkDevice } from '../../src/services/network-baseline.js';

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
