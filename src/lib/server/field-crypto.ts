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
 * Encrypt a plaintext value with a per-field random salt (v2 format).
 * Format: `enc2:<base64(salt[16] + iv[12] + tag[16] + ciphertext)>`
 */
export function encryptField(plaintext: string): string {
	const masterKey = deriveMasterKey();
	if (!masterKey || !plaintext) return plaintext;

	const salt = crypto.randomBytes(SALT_LENGTH);
	const fieldKey = deriveFieldKey(masterKey, salt);
	const iv = crypto.randomBytes(IV_LENGTH);
	const cipher = crypto.createCipheriv(ALGORITHM, fieldKey, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	return PREFIX_V2 + Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a ciphertext value. Supports both v2 (enc2:) and legacy v1 (enc:) formats.
 * v1 values are decrypted transparently; the caller's next write will re-encrypt as v2.
 */
export function decryptField(ciphertext: string): string {
	if (!ciphertext) return ciphertext;

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
