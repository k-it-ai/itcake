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
		expect(() => validateHostname('')).toThrow('error.invalidHostname');
	});

	it('rejects too-long hostname', () => {
		expect(() => validateHostname('a'.repeat(254))).toThrow('error.invalidHostname');
	});

	it('rejects shell metacharacters', () => {
		expect(() => validateHostname('host;rm -rf')).toThrow('error.invalidHostname');
		expect(() => validateHostname('host|cat')).toThrow('error.invalidHostname');
		expect(() => validateHostname('host$(cmd)')).toThrow('error.invalidHostname');
	});

	it('rejects option injection (leading dash)', () => {
		expect(() => validateHostname('-n 1')).toThrow('error.invalidHostname');
		expect(() => validateHostname('-c')).toThrow('error.invalidHostname');
	});

	it('rejects bracket forms that do not wrap a valid IPv6 (P2)', () => {
		// Loose char-class previously allowed `[127.0.0.1]` to pass and
		// reach dns.lookup, where on glibc with NSS quirks it could
		// resolve via /etc/hosts aliases.
		expect(() => validateHostname('[127.0.0.1]')).toThrow('error.invalidHostname');
		expect(() => validateHostname('[example.com]')).toThrow('error.invalidHostname');
		expect(() => validateHostname('[::1')).toThrow('error.invalidHostname');
		expect(() => validateHostname('::1]')).toThrow('error.invalidHostname');
	});

	it('still accepts bracketed legitimate IPv6 literals', () => {
		expect(() => validateHostname('[::1]')).not.toThrow();
		expect(() => validateHostname('[2001:db8::1]')).not.toThrow();
	});
});

describe('resolveAndValidate', () => {
	it('blocks loopback IPv4', async () => {
		await expect(resolveAndValidate('127.0.0.1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('127.255.255.255')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks private ranges', async () => {
		await expect(resolveAndValidate('10.0.0.1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('172.16.0.1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('172.31.255.255')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('192.168.0.1')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks link-local / metadata', async () => {
		await expect(resolveAndValidate('169.254.169.254')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks CGNAT (RFC 6598)', async () => {
		await expect(resolveAndValidate('100.64.0.1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('100.127.255.255')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('allows valid public IPs between CGNAT boundaries', async () => {
		// 100.63.x.x is NOT in CGNAT range
		const result = await resolveAndValidate('100.63.0.1');
		expect(result).toBe('100.63.0.1');
	});

	it('blocks reserved ranges', async () => {
		await expect(resolveAndValidate('0.0.0.0')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('240.0.0.1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('198.18.0.1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('198.51.100.1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('203.0.113.1')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks IPv6 loopback', async () => {
		await expect(resolveAndValidate('::1')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks IPv6-mapped IPv4 loopback', async () => {
		await expect(resolveAndValidate('::ffff:127.0.0.1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('::ffff:10.0.0.1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('::ffff:169.254.169.254')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks IPv6 unique local', async () => {
		await expect(resolveAndValidate('fc00::1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('fd00::1')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks IPv6 link-local', async () => {
		await expect(resolveAndValidate('fe80::1')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks 6to4 addresses embedding private IPv4', async () => {
		// 2002:0a00:0001:: embeds 10.0.0.1 (private)
		await expect(resolveAndValidate('2002:0a00:0001::')).rejects.toThrow('error.targetBlockedIpRange');
		// 2002:7f00:0001:: embeds 127.0.0.1 (loopback)
		await expect(resolveAndValidate('2002:7f00:0001::')).rejects.toThrow('error.targetBlockedIpRange');
		// 2002:c0a8:0101:: embeds 192.168.1.1 (private)
		await expect(resolveAndValidate('2002:c0a8:0101::')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks Teredo addresses embedding private IPv4', async () => {
		// Teredo: last 32 bits XOR 0xFFFFFFFF = embedded IPv4
		// 127.0.0.1 XOR 0xFFFFFFFF = 0x80FFFFFE → 2001:0000::80ff:fffe
		await expect(resolveAndValidate('2001:0000:0000:0000:0000:0000:80ff:fffe')).rejects.toThrow('error.targetBlockedIpRange');
		// 10.0.0.1 XOR 0xFFFFFFFF = 0xF5FFFFFE → 2001:0000::f5ff:fffe
		await expect(resolveAndValidate('2001:0000:0000:0000:0000:0000:f5ff:fffe')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('allows 6to4 addresses embedding public IPv4', async () => {
		// 2002:0808:0808:: embeds 8.8.8.8 (public)
		const result = await resolveAndValidate('2002:0808:0808::');
		expect(result).toBe('2002:0808:0808::');
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

	// --- SSRF bypass PoC tests (NET-001, NET-002) ---

	it('blocks IPv6-mapped IPv4 in expanded form (NET-001 SSRF bypass)', async () => {
		// This was the actual exploit: full-form IPv6-mapped IPv4 bypassed ::ffff: prefix check
		await expect(resolveAndValidate('0000:0000:0000:0000:0000:ffff:7f00:0001')).rejects.toThrow('error.targetBlockedIpRange');
		// Cloud metadata endpoint
		await expect(resolveAndValidate('0000:0000:0000:0000:0000:ffff:a9fe:a9fe')).rejects.toThrow('error.targetBlockedIpRange');
		// Private network
		await expect(resolveAndValidate('0000:0000:0000:0000:0000:ffff:0a00:0001')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('0000:0000:0000:0000:0000:ffff:c0a8:0001')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks IPv6-mapped IPv4 in hex notation after ::ffff: (NET-002 SSRF bypass)', async () => {
		// Hex form after ::ffff: prefix — net.isIPv4 fails on "7f00:1"
		await expect(resolveAndValidate('::ffff:7f00:1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('::ffff:a9fe:a9fe')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('::ffff:0a00:1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('::ffff:c0a8:1')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('blocks partially expanded IPv6-mapped IPv4', async () => {
		// Mixed compression forms
		await expect(resolveAndValidate('0:0:0:0:0:ffff:7f00:1')).rejects.toThrow('error.targetBlockedIpRange');
		await expect(resolveAndValidate('::ffff:192.168.0.1')).rejects.toThrow('error.targetBlockedIpRange');
	});

	it('returns resolved IP for hostnames', async () => {
		const ip = await resolveAndValidate('dns.google');
		// Could resolve to IPv4 or IPv6 depending on system config
		expect(ip.length).toBeGreaterThan(0);
	});
});
