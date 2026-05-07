/**
 * Two-pass tool-result compaction with secret stripping.
 *
 * Tool results that go back to the model can be huge — a list_agents call
 * might return 200 agents with 30 fields each. The model doesn't need
 * every field; it needs enough context to answer the user. Two-pass
 * shrink: try with generous limits first, if still too big fall back to
 * aggressive limits.
 *
 * Secret stripping: even a tool that has no business surfacing secrets
 * might include them by accident — e.g. a command stdout that shows an
 * env var. Walk every string and replace bare-secret-shaped substrings
 * with [REDACTED:<kind>].
 */

const FIRST_PASS = { stringMax: 1500, arrayMax: 60, depth: 6, objectKeyMax: 50 };
const FALLBACK_PASS = { stringMax: 700, arrayMax: 20, depth: 4, objectKeyMax: 20 };

const SECRET_PATTERNS: Array<{ kind: string; re: RegExp }> = [
	{ kind: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
	{ kind: 'openai-api-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
	{ kind: 'github-token', re: /\bgh[pous]_[A-Za-z0-9]{20,}\b/g },
	{ kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ kind: 'slack-bot-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
	{ kind: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
];

const SCRIPT_BODY_FIELDS = new Set(['scriptContent', 'scriptBody', 'command', 'payloadRaw', 'rawCommand']);

interface CompactLimits {
	stringMax: number;
	arrayMax: number;
	depth: number;
	objectKeyMax: number;
}

function stripSecrets(s: string): string {
	let out = s;
	for (const p of SECRET_PATTERNS) out = out.replace(p.re, `[REDACTED:${p.kind}]`);
	return out;
}

function compactValue(v: unknown, limits: CompactLimits, depth: number): unknown {
	if (depth > limits.depth) return '[truncated:max-depth]';
	if (v === null || v === undefined) return v;
	if (typeof v === 'string') {
		const stripped = stripSecrets(v);
		return stripped.length > limits.stringMax
			? `${stripped.slice(0, limits.stringMax)}…[+${stripped.length - limits.stringMax} chars]`
			: stripped;
	}
	if (typeof v === 'number' || typeof v === 'boolean') return v;
	if (Array.isArray(v)) {
		const arr = v.slice(0, limits.arrayMax).map(item => compactValue(item, limits, depth + 1));
		if (v.length > limits.arrayMax) arr.push(`[+${v.length - limits.arrayMax} items]`);
		return arr;
	}
	if (typeof v === 'object') {
		const entries = Object.entries(v as Record<string, unknown>);
		const out: Record<string, unknown> = {};
		let count = 0;
		for (const [k, val] of entries) {
			if (count >= limits.objectKeyMax) {
				out['__truncated'] = `+${entries.length - count} keys`;
				break;
			}
			if (SCRIPT_BODY_FIELDS.has(k) && typeof val === 'string' && val.length > 200) {
				out[k] = `[script body omitted, ${val.length} chars]`;
			} else {
				out[k] = compactValue(val, limits, depth + 1);
			}
			count++;
		}
		return out;
	}
	return String(v);
}

export interface CompactedResult {
	json: string;
	bytes: number;
	pass: 'first' | 'fallback';
	originalBytes: number;
}

const TARGET_BYTES = 8 * 1024;

export function compactToolResultForChat(value: unknown): CompactedResult {
	const originalBytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
	const first = JSON.stringify(compactValue(value, FIRST_PASS, 0));
	const firstBytes = Buffer.byteLength(first, 'utf8');
	if (firstBytes <= TARGET_BYTES) {
		return { json: first, bytes: firstBytes, pass: 'first', originalBytes };
	}
	const fallback = JSON.stringify(compactValue(value, FALLBACK_PASS, 0));
	return {
		json: fallback,
		bytes: Buffer.byteLength(fallback, 'utf8'),
		pass: 'fallback',
		originalBytes
	};
}
