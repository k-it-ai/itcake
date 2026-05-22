const FIRST_PASS = { stringMax: 1500, arrayMax: 60, depth: 6, objectKeyMax: 50 };
const FALLBACK_PASS = { stringMax: 700, arrayMax: 20, depth: 4, objectKeyMax: 20 };

const SECRET_PATTERNS: Array<{ kind: string; re: RegExp }> = [
	{ kind: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
	{ kind: 'openai-api-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
	{ kind: 'github-token', re: /\bgh[pous]_[A-Za-z0-9]{20,}\b/g },
	{ kind: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
	{ kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ kind: 'aws-temp-access-key', re: /\bASIA[0-9A-Z]{16}\b/g },
	{ kind: 'slack-bot-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
	{ kind: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
	{ kind: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]{20,}\b/g },
	{ kind: 'twilio-account-sid', re: /\bAC[a-f0-9]{32}\b/g },
	{ kind: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },
	{ kind: 'azure-conn-string', re: /\bDefaultEndpointsProtocol=[A-Za-z]+;AccountName=[A-Za-z0-9]+;AccountKey=[A-Za-z0-9+/=]+/g },
	{ kind: 'gcp-service-account', re: /"type":\s*"service_account"/g },
	{ kind: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
	{ kind: 'docker-hub-token', re: /\bdckr_pat_[A-Za-z0-9_-]{20,}\b/g },
	{ kind: 'discord-bot-token', re: /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}\b/g },
	{ kind: 'notion-token', re: /\bsecret_[A-Za-z0-9]{43}\b/g },
	// `enc3:` (and legacy `enc2:`) AES-GCM ciphertexts used by every
	// ITCake-encrypted credential (settings creds, per-agent HMAC + RDP
	// creds, user TOTP secrets). Defense-in-depth — operator-facing API
	// surfaces already mask these, but a future tool that inadvertently
	// returns a settings row or an agent row's `data` column would leak
	// the ciphertext into the SSE stream and `ai_messages` DB without
	// this filter. Ciphertexts are useless without SESSION_SECRET but
	// their presence violates the stated invariant.
	{ kind: 'itcake-encrypted-blob', re: /\benc\d+:[A-Za-z0-9+/=]{30,}/g }
];

// Sensitive key names — the entire value is redacted regardless of its
// string format. Catches credentials that don't match a token-shape
// pattern (the field-crypto blob already covers `enc3:`; this is for
// plaintext-shape values that nevertheless live under a sensitive name).
const SENSITIVE_KEY_NAMES = new Set([
	'password', 'passphrase', 'apiKey', 'secret', 'privateKey', 'hmacSecret',
	'token', 'bearer', 'authorization', 'auth', 'cookie', 'sessionToken',
	'recoveryCode', 'mfaCode', 'totpSecret', 'totpCode', 'encryptionPassphrase',
	'secretAccessKey', 'accessKeyId', 'botToken', 'dsn', 'errorReportingDsn'
]);

const SCRIPT_BODY_FIELDS = new Set(['scriptContent', 'scriptBody', 'scriptName', 'command', 'payloadRaw', 'rawCommand']);

interface CompactLimits {
	stringMax: number;
	arrayMax: number;
	depth: number;
	objectKeyMax: number;
}

export function stripSecrets(s: string): string {
	let out = s;
	for (const p of SECRET_PATTERNS) out = out.replace(p.re, `[REDACTED:${p.kind}]`);
	return out;
}

export function redactSensitiveInput<T>(v: T): T {
	if (v === null || v === undefined) return v;
	if (typeof v === 'string') return stripSecrets(v) as unknown as T;
	if (typeof v === 'number' || typeof v === 'boolean') return v;
	if (Array.isArray(v)) return v.map(item => redactSensitiveInput(item)) as unknown as T;
	if (typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			// Redact-by-key-name: a non-empty string under a sensitive
			// key collapses to `[REDACTED:sensitive-key:<name>]` even if
			// its content doesn't match any token-shape regex.
			if (SENSITIVE_KEY_NAMES.has(k) && typeof val === 'string' && val.length > 0) {
				out[k] = `[REDACTED:sensitive-key:${k}]`;
			} else {
				out[k] = redactSensitiveInput(val);
			}
		}
		return out as unknown as T;
	}
	return v;
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
