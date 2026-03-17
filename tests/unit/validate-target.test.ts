import { describe, it, expect } from 'vitest';
import { validateHostname } from '../../src/lib/server/checks/validate-target.js';

// isBlockedIp is not exported, so we test it indirectly via resolveAndValidate
// For unit tests, we test validateHostname directly and isBlockedIp via the module

// Access isBlockedIp indirectly by importing the module and checking resolveAndValidate
import { resolveAndValidate } from '../../src/lib/server/checks/validate-target.js';

describe('validateHostname', () => {
	it('accepts valid hostnames', () => {
		expect(() => validateHostname('example.com')).not.toThrow();
		expect(() => validateHostname('sub.example.com')).not.toThrow();
		expect(() => validateHostname('192.168.1.1')).not.toThrow();
		expect(() => validateHostname('[::1]')).not.toThrow();
	});

	it('rejects empty hostname', () => {
		expect(() => validateHostname('')).toThrow('Invalid hostname');
	});

	it('rejects too-long hostname', () => {
		expect(() => validateHostname('a'.repeat(254))).toThrow('Invalid hostname');
	});

	it('rejects shell metacharacters', () => {
		expect(() => validateHostname('host;rm -rf')).toThrow('Invalid hostname characters');
		expect(() => validateHostname('host|cat')).toThrow('Invalid hostname characters');
		expect(() => validateHostname('host$(cmd)')).toThrow('Invalid hostname characters');
	});

	it('rejects option injection (leading dash)', () => {
		expect(() => validateHostname('-n 1')).toThrow('Invalid hostname characters');
		expect(() => validateHostname('-c')).toThrow('Hostname must not start with a dash');
	});
});

describe('resolveAndValidate', () => {
	it('blocks loopback IPv4', async () => {
		await expect(resolveAndValidate('127.0.0.1')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('127.255.255.255')).rejects.toThrow('blocked IP');
	});

	it('blocks private ranges', async () => {
		await expect(resolveAndValidate('10.0.0.1')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('172.16.0.1')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('172.31.255.255')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('192.168.0.1')).rejects.toThrow('blocked IP');
	});

	it('blocks link-local / metadata', async () => {
		await expect(resolveAndValidate('169.254.169.254')).rejects.toThrow('blocked IP');
	});

	it('blocks CGNAT (RFC 6598)', async () => {
		await expect(resolveAndValidate('100.64.0.1')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('100.127.255.255')).rejects.toThrow('blocked IP');
	});

	it('allows valid public IPs between CGNAT boundaries', async () => {
		// 100.63.x.x is NOT in CGNAT range
		const result = await resolveAndValidate('100.63.0.1');
		expect(result).toBe('100.63.0.1');
	});

	it('blocks reserved ranges', async () => {
		await expect(resolveAndValidate('0.0.0.0')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('240.0.0.1')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('198.18.0.1')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('198.51.100.1')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('203.0.113.1')).rejects.toThrow('blocked IP');
	});

	it('blocks IPv6 loopback', async () => {
		await expect(resolveAndValidate('::1')).rejects.toThrow('blocked IP');
	});

	it('blocks IPv6-mapped IPv4 loopback', async () => {
		await expect(resolveAndValidate('::ffff:127.0.0.1')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('::ffff:10.0.0.1')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('::ffff:169.254.169.254')).rejects.toThrow('blocked IP');
	});

	it('blocks IPv6 unique local', async () => {
		await expect(resolveAndValidate('fc00::1')).rejects.toThrow('blocked IP');
		await expect(resolveAndValidate('fd00::1')).rejects.toThrow('blocked IP');
	});

	it('blocks IPv6 link-local', async () => {
		await expect(resolveAndValidate('fe80::1')).rejects.toThrow('blocked IP');
	});

	it('allows valid public IPs', async () => {
		const result = await resolveAndValidate('8.8.8.8');
		expect(result).toBe('8.8.8.8');
	});

	it('allows public IPs outside blocked ranges', async () => {
		// 172.15.x.x is NOT private (172.16-31 is)
		const result = await resolveAndValidate('172.15.0.1');
		expect(result).toBe('172.15.0.1');
	});

	it('returns resolved IP for hostnames', async () => {
		const ip = await resolveAndValidate('dns.google');
		// Could resolve to IPv4 or IPv6 depending on system config
		expect(ip.length).toBeGreaterThan(0);
	});
});
