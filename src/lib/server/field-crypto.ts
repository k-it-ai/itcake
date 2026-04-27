import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;

/** Legacy prefix (v1): static salt, single derived key. Supported for decryption only. */
const PREFIX_V1 = 'enc:';
/** Current prefix (v2): per-field random salt via HKDF from scrypt master key. */
const PREFIX_V2 = 'enc2:';

/**
 * Strict ciphertext-prefix test. Returns true only for `enc:`, `enc2:`,
 * `enc3:` (and forward-compatibly `encN:` for any digit-suffixed
 * version). The previous `value.startsWith('enc')` check was loose:
 * a passphrase like `enc:test` would be treated as a v1 ciphertext and
 * silently decrypt to garbage, while a legitimate plaintext beginning
 * with the three letters "enc" (e.g. `enctype-...`) would also match
 * and trigger the decrypt branch.
 */
const ENC_PREFIX_RE = /^enc\d*:/;
export function isEncryptedField(value: string): boolean {
	return !!value && ENC_PREFIX_RE.test(value);
}
/**
 * v3: per-field random salt + HKDF + AES-256-GCM with **AAD** binding the
 * ciphertext to a caller-supplied label (e.g. `agent.hmacSecret:<id>`).
 *
 * v2 ciphertexts are byte-substitutable across rows/columns: a DB writer
 * who copies one agent's encrypted hmac_secret into another agent's row
 * has both agents sharing a key (no GCM-tag mismatch because the same
 * master key produces the same field key for the same salt). With v3,
 * AAD is bound at encrypt time and re-supplied at decrypt — a moved
 * ciphertext fails GCM tag verification because the AAD label of the
 * destination row differs from the source.
 *
 * Adopt v3 for any field whose value should be tied to a specific row /
 * field path. Bare `encryptField(s)` keeps producing v2 (no label) for
 * backward-compatible call sites.
 */
const PREFIX_V3 = 'enc3:';

// ── Master key (scrypt, derived once and cached) ──────────────────────

let cachedMasterKey: Buffer | null | undefined;

function deriveMasterKey(): Buffer | null {
	if (cachedMasterKey !== undefined) return cachedMasterKey;
	const secret = env.SESSION_SECRET;
	if (!secret) { cachedMasterKey = null; return null; }
	cachedMasterKey = crypto.scryptSync(secret, 'itcake-master-key-v2', KEY_LENGTH);
	return cachedMasterKey;
}

// ── Legacy key (for decrypting v1 enc: values during migration) ──────

let cachedLegacyKey: Buffer | null | undefined;

function deriveLegacyKey(): Buffer | null {
	if (cachedLegacyKey !== undefined) return cachedLegacyKey;
	const secret = env.SESSION_SECRET;
	if (!secret) { cachedLegacyKey = null; return null; }
	cachedLegacyKey = crypto.scryptSync(secret, 'itcake-backup-encryption', KEY_LENGTH);
	return cachedLegacyKey;
}

// ── Per-field key derivation (HKDF — fast, unique per salt) ──────────

function deriveFieldKey(masterKey: Buffer, salt: Buffer): Buffer {
	return Buffer.from(
		crypto.hkdfSync('sha256', masterKey, salt, 'itcake-field-encryption', KEY_LENGTH)
	);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Encrypt a plaintext value.
 *
 * - When `aad` is omitted: produces v2 (no label binding).
 * - When `aad` is provided: produces v3 with the label bound via AES-GCM
 *   AAD. The same `aad` MUST be passed to `decryptField` on read.
 *
 * Format v2: `enc2:<base64(salt[16] + iv[12] + tag[16] + ciphertext)>`
 * Format v3: `enc3:<base64(salt[16] + iv[12] + tag[16] + ciphertext)>`
 *           (the AAD is NOT stored; the caller supplies it on both ends)
 */
export function encryptField(plaintext: string, aad?: string): string {
	const masterKey = deriveMasterKey();
	if (!masterKey || !plaintext) return plaintext;

	const salt = crypto.randomBytes(SALT_LENGTH);
	const fieldKey = deriveFieldKey(masterKey, salt);
	const iv = crypto.randomBytes(IV_LENGTH);
	const cipher = crypto.createCipheriv(ALGORITHM, fieldKey, iv);
	if (aad) cipher.setAAD(Buffer.from(aad, 'utf-8'));
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	const prefix = aad ? PREFIX_V3 : PREFIX_V2;
	return prefix + Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

/**
 * Strict variant of `decryptField`: refuses to read a value that isn't
 * properly enc-prefixed when SESSION_SECRET is set. Use this for fields
 * that MUST be encrypted at rest (agent HMAC secrets, SMTP password,
 * Telegram bot token, TOTP secrets, backup credentials).
 *
 * Without this, a DB writer can replace an encrypted field with chosen
 * plaintext — the next read silently returns it (decryptField passes
 * non-prefixed values through unchanged). For an HMAC secret, that means
 * forgeable commands; for SMTP creds, attacker-controlled mail server.
 *
 * Returns `''` (the same as a failed decrypt) when SESSION_SECRET is
 * unset — callers handle missing crypto gracefully on dev boxes.
 */
export function decryptFieldStrict(ciphertext: string, aad?: string): string {
	if (!ciphertext) return ciphertext;
	const isProperlyEncrypted = ciphertext.startsWith(PREFIX_V3) ||
		ciphertext.startsWith(PREFIX_V2) ||
		ciphertext.startsWith(PREFIX_V1);
	const secretSet = !!env.SESSION_SECRET;
	if (secretSet && !isProperlyEncrypted) {
		// SESSION_SECRET is set but the value on disk isn't encrypted —
		// either a migration was skipped or a DB writer attempted a
		// plaintext-downgrade attack. Either way, refuse the read.
		console.error('[field-crypto] STRICT decrypt refused: value is not enc-prefixed but SESSION_SECRET is set. Possible plaintext downgrade.');
		return '';
	}
	return decryptField(ciphertext, aad);
}

/**
 * Decrypt a ciphertext value. Supports v3, v2, and legacy v1 formats.
 *
 * For v3 ciphertexts the caller MUST supply the same `aad` that was used
 * at encrypt time. Mismatch / missing AAD fails GCM tag verification —
 * the ciphertext is rejected as if it were corrupt. This is intentional:
 * a row whose v3 ciphertext was moved from another row will fail to
 * decrypt at its new location.
 */
export function decryptField(ciphertext: string, aad?: string): string {
	if (!ciphertext) return ciphertext;

	if (ciphertext.startsWith(PREFIX_V3)) {
		return decryptV3(ciphertext, aad ?? '');
	}
	if (ciphertext.startsWith(PREFIX_V2)) {
		return decryptV2(ciphertext);
	}
	if (ciphertext.startsWith(PREFIX_V1)) {
		return decryptV1(ciphertext);
	}
	// Not encrypted (plaintext passthrough, e.g. dev mode without SESSION_SECRET)
	return ciphertext;
}

function decryptV2(ciphertext: string): string {
	const masterKey = deriveMasterKey();
	if (!masterKey) {
		console.error('[field-crypto] Cannot decrypt enc2: value — SESSION_SECRET not set. Encrypted credentials will be unavailable.');
		return '';
	}
	try {
		const data = Buffer.from(ciphertext.slice(PREFIX_V2.length), 'base64');
		const salt = data.subarray(0, SALT_LENGTH);
		const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
		const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
		const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

		const fieldKey = deriveFieldKey(masterKey, salt);
		const decipher = crypto.createDecipheriv(ALGORITHM, fieldKey, iv);
		decipher.setAuthTag(tag);
		return decipher.update(encrypted) + decipher.final('utf8');
	} catch (e) {
		console.error('[field-crypto] v2 decryption FAILED — SESSION_SECRET changed or data corrupted. SMTP/Telegram credentials are now unavailable. Re-enter credentials in Settings or restore the original SESSION_SECRET.', e instanceof Error ? e.message : e);
		return '';
	}
}

function decryptV3(ciphertext: string, aad: string): string {
	const masterKey = deriveMasterKey();
	if (!masterKey) {
		console.error('[field-crypto] Cannot decrypt enc3: value — SESSION_SECRET not set.');
		return '';
	}
	if (!aad) {
		// v3 was used to encrypt this — caller MUST pass the same AAD on
		// decrypt. Refuse rather than silently weaken: the whole point
		// of v3 is the binding, and a missing label means the caller is
		// using the value cross-context.
		console.error('[field-crypto] v3 ciphertext requires an AAD on decrypt.');
		return '';
	}
	try {
		const data = Buffer.from(ciphertext.slice(PREFIX_V3.length), 'base64');
		const salt = data.subarray(0, SALT_LENGTH);
		const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
		const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
		const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

		const fieldKey = deriveFieldKey(masterKey, salt);
		const decipher = crypto.createDecipheriv(ALGORITHM, fieldKey, iv);
		decipher.setAuthTag(tag);
		decipher.setAAD(Buffer.from(aad, 'utf-8'));
		return decipher.update(encrypted) + decipher.final('utf8');
	} catch (e) {
		console.error('[field-crypto] v3 decryption FAILED — possible cross-row substitution, AAD mismatch, or SESSION_SECRET changed.', e instanceof Error ? e.message : e);
		return '';
	}
}

function decryptV1(ciphertext: string): string {
	const key = deriveLegacyKey();
	if (!key) {
		console.error('[field-crypto] Cannot decrypt enc: value — SESSION_SECRET not set. Encrypted credentials will be unavailable.');
		return '';
	}
	try {
		const data = Buffer.from(ciphertext.slice(PREFIX_V1.length), 'base64');
		const iv = data.subarray(0, IV_LENGTH);
		const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
		const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
		const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(tag);
		return decipher.update(encrypted) + decipher.final('utf8');
	} catch (e) {
		console.error('[field-crypto] v1 decryption FAILED — SESSION_SECRET changed or data corrupted. Re-enter credentials in Settings or restore the original SESSION_SECRET.', e instanceof Error ? e.message : e);
		return '';
	}
}
