import dns from 'node:dns/promises';
import net from 'node:net';
import { ServiceError } from '$lib/server/service-error.js';

/** Hostname character allowlist: alphanumeric, dots, hyphens, colons (IPv6), brackets. */
const HOSTNAME_RE = /^[a-zA-Z0-9.\-:[\]]+$/;

/** Reject targets that could be ping/TLS option injection or contain shell-meaningful chars. */
export function validateHostname(hostname: string): void {
	if (!hostname || hostname.length > 253) throw new ServiceError('error.invalidHostname');
	if (!HOSTNAME_RE.test(hostname)) throw new ServiceError('error.invalidHostname');
	if (hostname.startsWith('-')) throw new ServiceError('error.invalidHostname');
}

/** Expand a compressed IPv6 address to its full 8-group hex form. */
function expandIPv6(ip: string): string {
	const halves = ip.split('::');
	const expand = (s: string) => s ? s.split(':') : [];
	const left = expand(halves[0]);
	const right = halves.length > 1 ? expand(halves[1]) : [];
	const fill = Array(8 - left.length - right.length).fill('0000');
	return [...left, ...fill, ...right].map(g => g.padStart(4, '0')).join(':');
}

/** Blocked IP ranges: loopback, link-local, private (RFC 1918/6598), metadata, reserved. */
function isBlockedIp(ip: string): boolean {
	if (net.isIPv4(ip)) {
		const parts = ip.split('.').map(Number);
		// 127.0.0.0/8
		if (parts[0] === 127) return true;
		// 10.0.0.0/8
		if (parts[0] === 10) return true;
		// 172.16.0.0/12
		if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
		// 192.168.0.0/16
		if (parts[0] === 192 && parts[1] === 168) return true;
		// 169.254.0.0/16 (link-local / cloud metadata)
		if (parts[0] === 169 && parts[1] === 254) return true;
		// 0.0.0.0/8
		if (parts[0] === 0) return true;
		// 100.64.0.0/10 (CGNAT, RFC 6598)
		if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
		// 192.0.0.0/24 (IETF protocol assignments)
		if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
		// 198.18.0.0/15 (benchmarking)
		if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
		// 192.0.2.0/24 (documentation TEST-NET-1)
		if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;
		// 198.51.100.0/24 (documentation TEST-NET-2)
		if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
		// 203.0.113.0/24 (documentation TEST-NET-3)
		if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
		// 240.0.0.0/4 (reserved/future)
		if (parts[0] >= 240) return true;
		return false;
	}
	if (net.isIPv6(ip)) {
		const lower = ip.toLowerCase();
		// :: unspecified address
		if (lower === '::') return true;
		// Normalize to full form for all IPv6 checks — prevents bypass via
		// compressed vs expanded representations (e.g., ::ffff:7f00:1 vs
		// 0000:0000:0000:0000:0000:ffff:7f00:0001 both map to 127.0.0.1)
		const full = expandIPv6(lower);
		const hex = full.replace(/:/g, '');
		// IPv6-mapped IPv4 — groups 5-6 are 0000:ffff, groups 7-8 embed IPv4
		// Handles all representations: ::ffff:127.0.0.1, ::ffff:7f00:1,
		// 0000:0000:0000:0000:0000:ffff:7f00:0001
		if (hex.slice(0, 20) === '00000000000000000000' && hex.slice(20, 24) === 'ffff') {
			const embedded = [
				parseInt(hex.slice(24, 26), 16),
				parseInt(hex.slice(26, 28), 16),
				parseInt(hex.slice(28, 30), 16),
				parseInt(hex.slice(30, 32), 16)
			].join('.');
			if (net.isIPv4(embedded)) return isBlockedIp(embedded);
		}
		// Also check the dotted-decimal form (::ffff:127.0.0.1)
		if (lower.startsWith('::ffff:')) {
			const mapped = lower.slice(7);
			if (net.isIPv4(mapped)) return isBlockedIp(mapped);
		}
		// ::1 loopback
		if (lower === '::1' || full === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
		// fe80::/10 link-local (covers fe80-febf range)
		const firstWord = lower.split(':')[0];
		if (firstWord.length === 4 && firstWord >= 'fe80' && firstWord <= 'febf') return true;
		// fc00::/7 unique local
		if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
		// 64:ff9b::/96 NAT64 well-known prefix (could reach private IPv4 via IPv6)
		if (lower.startsWith('64:ff9b:')) return true;
		// 2001:db8::/32 documentation
		if (lower.startsWith('2001:db8:') || lower.startsWith('2001:0db8:')) return true;
		// 2002::/16 (6to4) — bytes 3-6 embed an IPv4 address
		if (lower.startsWith('2002:')) {
			const embedded6to4 = [
				parseInt(hex.slice(4, 6), 16),
				parseInt(hex.slice(6, 8), 16),
				parseInt(hex.slice(8, 10), 16),
				parseInt(hex.slice(10, 12), 16)
			].join('.');
			if (net.isIPv4(embedded6to4) && isBlockedIp(embedded6to4)) return true;
		}
		// 2001:0000::/32 (Teredo) — last 32 bits embed an IPv4 address XOR'd with 0xFFFFFFFF
		if (hex.startsWith('20010000')) {
			const embeddedTeredo = [
				parseInt(hex.slice(24, 26), 16) ^ 0xFF,
				parseInt(hex.slice(26, 28), 16) ^ 0xFF,
				parseInt(hex.slice(28, 30), 16) ^ 0xFF,
				parseInt(hex.slice(30, 32), 16) ^ 0xFF
			].join('.');
			if (net.isIPv4(embeddedTeredo) && isBlockedIp(embeddedTeredo)) return true;
		}
		return false;
	}
	return false;
}

/**
 * Resolve hostname, reject if it points to a blocked IP, and return the validated IP.
 * Callers should use the returned IP for the actual connection to prevent DNS rebinding.
 */
export async function resolveAndValidate(hostname: string): Promise<string> {
	if (net.isIP(hostname)) {
		if (isBlockedIp(hostname)) throw new ServiceError('error.targetBlockedIpRange');
		return hostname;
	}

	try {
		const { address } = await dns.lookup(hostname);
		if (isBlockedIp(address)) {
			throw new ServiceError('error.targetBlockedIpRange');
		}
		return address;
	} catch (e) {
		if (e instanceof ServiceError) throw e;
		throw new Error(`DNS resolution failed for ${hostname}`);
	}
}
