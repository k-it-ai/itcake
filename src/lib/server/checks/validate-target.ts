import dns from 'node:dns/promises';
import net from 'node:net';
import { ServiceError } from '#lib/server/service-error.js';

// Underscore allowed for legacy AD / on-prem SMTP subdomain labels.
const HOSTNAME_RE = /^[a-zA-Z0-9_.\-:[\]]+$/;

export function validateHostname(hostname: string): void {
	if (!hostname || hostname.length > 253) throw new ServiceError('error.invalidHostname');
	if (!HOSTNAME_RE.test(hostname)) throw new ServiceError('error.invalidHostname');
	if (hostname.startsWith('-')) throw new ServiceError('error.invalidHostname');
	const hasOpen = hostname.includes('[');
	const hasClose = hostname.includes(']');
	if (hasOpen || hasClose) {
		if (!hostname.startsWith('[') || !hostname.endsWith(']')) {
			throw new ServiceError('error.invalidHostname');
		}
		const inner = hostname.slice(1, -1);
		if (!net.isIPv6(inner)) throw new ServiceError('error.invalidHostname');
	}
}

function expandIPv6(ip: string): string {
	const halves = ip.split('::');
	const expand = (s: string) => s ? s.split(':') : [];
	let left = expand(halves[0]);
	let right = halves.length > 1 ? expand(halves[1]) : [];
	const unfoldLastDottedQuad = (groups: string[]): string[] => {
		if (groups.length === 0) return groups;
		const last = groups[groups.length - 1];
		if (!last.includes('.')) return groups;
		const octets = last.split('.');
		if (octets.length !== 4) return groups; // malformed — leave as-is
		const valid = octets.every(o => /^\d+$/.test(o) && Number(o) >= 0 && Number(o) <= 255);
		if (!valid) return groups;
		const high = ((Number(octets[0]) << 8) | Number(octets[1])).toString(16);
		const low = ((Number(octets[2]) << 8) | Number(octets[3])).toString(16);
		return [...groups.slice(0, -1), high, low];
	};
	left = unfoldLastDottedQuad(left);
	right = unfoldLastDottedQuad(right);
	const fillCount = Math.max(0, 8 - left.length - right.length);
	const fill = Array(fillCount).fill('0000');
	return [...left, ...fill, ...right].map(g => g.padStart(4, '0')).join(':');
}

/** Blocked IP ranges: loopback, link-local, private (RFC 1918/6598), metadata, reserved. */
export function isBlockedIp(ip: string): boolean {
	if (net.isIPv4(ip)) {
		const parts = ip.split('.').map(Number);
		if (parts[0] === 127) return true;
		if (parts[0] === 10) return true;
		if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
		if (parts[0] === 192 && parts[1] === 168) return true;
		if (parts[0] === 169 && parts[1] === 254) return true;
		if (parts[0] === 0) return true;
		// 100.64.0.0/10 (CGNAT, RFC 6598)
		if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
		if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
		if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
		if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;
		if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
		if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
		if (parts[0] >= 224 && parts[0] <= 239) return true;
		if (parts[0] >= 240) return true;
		if (parts[0] === 192 && parts[1] === 88 && parts[2] === 99) return true;
		return false;
	}
	if (net.isIPv6(ip)) {
		const lower = ip.toLowerCase();
		const full = expandIPv6(lower);
		const hex = full.replace(/:/g, '');
		if (hex === '00000000000000000000000000000000') return true;
		if (hex.slice(0, 20) === '00000000000000000000' && hex.slice(20, 24) === 'ffff') {
			const embedded = [
				parseInt(hex.slice(24, 26), 16),
				parseInt(hex.slice(26, 28), 16),
				parseInt(hex.slice(28, 30), 16),
				parseInt(hex.slice(30, 32), 16)
			].join('.');
			if (net.isIPv4(embedded)) return isBlockedIp(embedded);
		}
		if (lower.startsWith('::ffff:')) {
			const mapped = lower.slice(7);
			if (net.isIPv4(mapped)) return isBlockedIp(mapped);
		}
		if (lower === '::1' || full === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
		const firstWord = lower.split(':')[0];
		if (firstWord.length === 4 && firstWord >= 'fe80' && firstWord <= 'febf') return true;
		if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
		if (firstWord.length === 4 && firstWord >= 'fec0' && firstWord <= 'feff') return true;
		if (lower.startsWith('ff')) return true;
		// NAT64 64:ff9b::/96 — hex-form check defeats non-canonical `0064:ff9b:...` literals.
		if (hex.startsWith('0064ff9b')) return true;
		if (lower.startsWith('2001:db8:') || lower.startsWith('2001:0db8:')) return true;
		if (lower.startsWith('2002:')) {
			const embedded6to4 = [
				parseInt(hex.slice(4, 6), 16),
				parseInt(hex.slice(6, 8), 16),
				parseInt(hex.slice(8, 10), 16),
				parseInt(hex.slice(10, 12), 16)
			].join('.');
			if (net.isIPv4(embedded6to4) && isBlockedIp(embedded6to4)) return true;
		}
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

export async function resolveTarget(hostname: string): Promise<string> {
	validateHostname(hostname);
	return resolveAndValidate(hostname);
}

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
