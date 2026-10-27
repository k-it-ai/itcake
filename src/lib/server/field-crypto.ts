import crypto from 'node:crypto';
import { NODE_ENV, SESSION_SECRET, FIELD_ENCRYPTION_KEY } from '$app/env/private';
import {
	FIELD_ALGORITHM,
	FIELD_KEY_INFO,
	IV_LENGTH,
	KEY_LENGTH,
	MASTER_KEY_SALT,
	MASTER_KEY_SCRYPT_OPTS,
	SALT_LENGTH,
	TAG_LENGTH
} from './field-crypto-params.js';

const PREFIX_V2 = 'enc2:';
const PREFIX_V3 = 'enc3:';

const ENC_PREFIX_RE = /^enc\d*:/;
export function isEncryptedField(value: string): boolean {
	return !!value && ENC_PREFIX_RE.test(value);
}

let cachedPrimaryKey: Buffer | null | undefined;
let cachedSessionKey: Buffer | null | undefined;

function deriveKey(secret: string): Buffer {
	return crypto.scryptSync(secret, MASTER_KEY_SALT, KEY_LENGTH, MASTER_KEY_SCRYPT_OPTS);
}

// New writes use a dedicated FIELD_ENCRYPTION_KEY when set, so rotating
// SESSION_SECRET no longer breaks field decryption. Existing blobs fall back to
// the SESSION_SECRET-derived key.
function primaryKey(): Buffer | null {
	if (cachedPrimaryKey !== undefined) return cachedPrimaryKey;
	const secret = FIELD_ENCRYPTION_KEY || SESSION_SECRET;
	cachedPrimaryKey = secret ? deriveKey(secret) : null;
	return cachedPrimaryKey;
}

function sessionKey(): Buffer | null {
	if (cachedSessionKey !== undefined) return cachedSessionKey;
	cachedSessionKey = SESSION_SECRET ? deriveKey(SESSION_SECRET) : null;
	return cachedSessionKey;
}

function deriveFieldKey(masterKey: Buffer, salt: Buffer): Buffer {
	return Buffer.from(
		crypto.hkdfSync('sha256', masterKey, salt, FIELD_KEY_INFO, KEY_LENGTH)
	);
}

export function encryptField(plaintext: string, aad?: string): string {
	if (!plaintext) return plaintext;
	const masterKey = primaryKey();
	if (!masterKey) {
		if (NODE_ENV !== 'development') {
			throw new Error('encryptField: FIELD_ENCRYPTION_KEY/SESSION_SECRET unset; refusing to store credential in plaintext');
		}
		return plaintext;
	}

	const salt = crypto.randomBytes(SALT_LENGTH);
	const fieldKey = deriveFieldKey(masterKey, salt);
	const iv = crypto.randomBytes(IV_LENGTH);
	const cipher = crypto.createCipheriv(FIELD_ALGORITHM, fieldKey, iv);
	if (aad) cipher.setAAD(Buffer.from(aad, 'utf-8'));
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	const prefix = aad ? PREFIX_V3 : PREFIX_V2;
	return prefix + Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

export function decryptFieldStrict(ciphertext: string, aad?: string): string {
	if (!ciphertext) return ciphertext;
	if ((SESSION_SECRET || FIELD_ENCRYPTION_KEY) && !isEncryptedField(ciphertext)) {
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

function tryDecryptV2(ciphertext: string, masterKey: Buffer): string | null {
	try {
		const data = Buffer.from(ciphertext.slice(PREFIX_V2.length), 'base64');
		const salt = data.subarray(0, SALT_LENGTH);
		const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
		const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
		const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

		const fieldKey = deriveFieldKey(masterKey, salt);
		const decipher = crypto.createDecipheriv(FIELD_ALGORITHM, fieldKey, iv);
		decipher.setAuthTag(tag);
		return decipher.update(encrypted) + decipher.final('utf8');
	} catch {
		return null;
	}
}

function decryptV2(ciphertext: string): string {
	const primary = primaryKey();
	const session = sessionKey();
	if (primary) {
		const plain = tryDecryptV2(ciphertext, primary);
		if (plain !== null) return plain;
	}
	if (session && (!primary || !session.equals(primary))) {
		const plain = tryDecryptV2(ciphertext, session);
		if (plain !== null) return plain;
	}
	console.error('[field-crypto] v2 decryption FAILED — field key or SESSION_SECRET changed, or data corrupted. Re-enter credentials in Settings or restore the original key.');
	return '';
}

function tryDecryptV3(ciphertext: string, aad: string, masterKey: Buffer): string | null {
	try {
		const data = Buffer.from(ciphertext.slice(PREFIX_V3.length), 'base64');
		const salt = data.subarray(0, SALT_LENGTH);
		const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
		const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
		const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

		const fieldKey = deriveFieldKey(masterKey, salt);
		const decipher = crypto.createDecipheriv(FIELD_ALGORITHM, fieldKey, iv);
		decipher.setAuthTag(tag);
		decipher.setAAD(Buffer.from(aad, 'utf-8'));
		return decipher.update(encrypted) + decipher.final('utf8');
	} catch {
		return null;
	}
}

function decryptV3(ciphertext: string, aad: string): string {
	const primary = primaryKey();
	const session = sessionKey();
	if (primary) {
		const plain = tryDecryptV3(ciphertext, aad, primary);
		if (plain !== null) return plain;
	}
	if (session && (!primary || !session.equals(primary))) {
		const plain = tryDecryptV3(ciphertext, aad, session);
		if (plain !== null) return plain;
	}
	console.error('[field-crypto] v3 decryption FAILED — possible cross-row substitution, AAD mismatch, or field key changed.');
	return '';
}
