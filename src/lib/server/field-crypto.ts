import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;

const PREFIX_V2 = 'enc2:';
const PREFIX_V3 = 'enc3:';

const ENC_PREFIX_RE = /^enc\d*:/;
export function isEncryptedField(value: string): boolean {
	return !!value && ENC_PREFIX_RE.test(value);
}

let cachedMasterKey: Buffer | null | undefined;

// Hardened scrypt parameters for the master-key derivation. Matches the
// posture of backup-crypto.ts (N=2^17, r=8, p=1, maxmem=256 MB). Node's
// default is N=2^14 / maxmem=32 MB, which is 8× weaker against an
// offline brute-force on SESSION_SECRET. Cost is paid ONCE at process
// startup (cached for the lifetime of the process), so the runtime
// impact is bounded; 1-second startup delta vs 1-byte-per-second
// throughput drop is the right trade-off.
const MASTER_KEY_SCRYPT_OPTS = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

function deriveMasterKey(): Buffer | null {
	if (cachedMasterKey !== undefined) return cachedMasterKey;
	const secret = env.SESSION_SECRET;
	if (!secret) { cachedMasterKey = null; return null; }
	cachedMasterKey = crypto.scryptSync(secret, 'itcake-master-key-v2', KEY_LENGTH, MASTER_KEY_SCRYPT_OPTS);
	return cachedMasterKey;
}

function deriveFieldKey(masterKey: Buffer, salt: Buffer): Buffer {
	return Buffer.from(
		crypto.hkdfSync('sha256', masterKey, salt, 'itcake-field-encryption', KEY_LENGTH)
	);
}

export function encryptField(plaintext: string, aad?: string): string {
	if (!plaintext) return plaintext;
	const masterKey = deriveMasterKey();
	if (!masterKey) {
		// startup-invariants.ts already refuses to boot in production without
		// SESSION_SECRET. Belt-and-braces: refuse to write a credential as
		// plaintext rather than silently downgrading.
		if (env.NODE_ENV !== 'development') {
			throw new Error('encryptField: SESSION_SECRET unset; refusing to store credential in plaintext');
		}
		return plaintext;
	}

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

export function decryptFieldStrict(ciphertext: string, aad?: string): string {
	if (!ciphertext) return ciphertext;
	if (env.SESSION_SECRET && !isEncryptedField(ciphertext)) {
		console.error('[field-crypto] STRICT decrypt refused: value is not enc-prefixed but SESSION_SECRET is set. Possible plaintext downgrade.');
		return '';
	}
	return decryptField(ciphertext, aad);
}

export function decryptField(ciphertext: string, aad?: string): string {
	if (!ciphertext) return ciphertext;
	if (ciphertext.startsWith(PREFIX_V3)) return decryptV3(ciphertext, aad ?? '');
	if (ciphertext.startsWith(PREFIX_V2)) {
		if (aad !== undefined) {
			console.error(`[field-crypto] enc2 ciphertext encountered with AAD requested ("${aad.slice(0, 60)}…"); refusing decrypt to prevent silent AAD-binding bypass.`);
			return '';
		}
		return decryptV2(ciphertext);
	}
	if (isEncryptedField(ciphertext)) {
		console.error('[field-crypto] Unsupported encrypted-prefix on read. Re-enter the affected credential.');
		return '';
	}
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

