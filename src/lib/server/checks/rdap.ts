interface DomainExpiryResult {
	expiryDate: string;
	daysRemaining: number;
}

const MAX_RDAP_BODY = 512 * 1024; // 512KB limit for RDAP responses

/** Extract base domain from a hostname (strip subdomains). Simple heuristic. */
function extractBaseDomain(input: string): string {
	if (!input) throw new Error('No domain specified');
	// Remove protocol/path if present
	let domain = input.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
	const parts = domain.split('.');
	// Handle two-part TLDs like co.uk, com.au
	const twoPartTlds = ['co.uk', 'com.au', 'co.nz', 'com.br', 'co.za', 'org.uk', 'net.au', 'co.jp', 'co.kr'];
	if (parts.length >= 3) {
		const lastTwo = parts.slice(-2).join('.');
		if (twoPartTlds.includes(lastTwo)) {
			return parts.slice(-3).join('.');
		}
	}
	// Default: last two parts
	return parts.length >= 2 ? parts.slice(-2).join('.') : domain;
}

export async function checkDomainExpiry(domain: string, timeoutMs = 15000): Promise<DomainExpiryResult> {
	const baseDomain = extractBaseDomain(domain);
	const url = `https://rdap.org/domain/${encodeURIComponent(baseDomain)}`;

	const res = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		redirect: 'follow',  // rdap.org always 302s to the authoritative RDAP server; safe to follow (hardcoded origin)
		headers: { 'Accept': 'application/rdap+json, application/json' }
	});

	if (!res.ok) {
		throw new Error(`RDAP lookup failed: HTTP ${res.status}`);
	}

	// Size-limited body read to prevent memory exhaustion
	const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);
	if (contentLength > MAX_RDAP_BODY) {
		throw new Error('RDAP response too large');
	}
	const text = await res.text();
	if (text.length > MAX_RDAP_BODY) {
		throw new Error('RDAP response too large');
	}

	const data = JSON.parse(text) as {
		events?: Array<{ eventAction: string; eventDate: string }>;
	};

	const expEvent = data.events?.find(e => e.eventAction === 'expiration');
	if (!expEvent?.eventDate) {
		throw new Error('No expiration date in RDAP response');
	}

	const expiryDate = new Date(expEvent.eventDate).toISOString().split('T')[0];
	const daysRemaining = Math.floor((new Date(expEvent.eventDate).getTime() - Date.now()) / (86400 * 1000));
	return { expiryDate, daysRemaining };
}
