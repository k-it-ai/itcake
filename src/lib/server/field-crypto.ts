import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = 'enc:';

let cachedKey: Buffer | null | undefined;

function deriveKey(): Buffer | null {
	if (cachedKey !== undefined) return cachedKey;
	const secret = env.SESSION_SECRET;
	if (!secret) { cachedKey = null; return null; }
	cachedKey = crypto.scryptSync(secret, 'itcake-backup-encryption', KEY_LENGTH);
	return cachedKey;
}

export function encryptField(plaintext: string): string {
	const key = deriveKey();
	if (!key || !plaintext) return plaintext;
	const iv = crypto.randomBytes(IV_LENGTH);
	const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptField(ciphertext: string): string {
	if (!ciphertext || !ciphertext.startsWith(PREFIX)) return ciphertext;
	const key = deriveKey();
	if (!key) return '';
	try {
		const data = Buffer.from(ciphertext.slice(PREFIX.length), 'base64');
		const iv = data.subarray(0, IV_LENGTH);
		const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
		const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
		const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(tag);
		return decipher.update(encrypted) + decipher.final('utf8');
	} catch {
		console.warn('[field-crypto] Decryption failed — possible SESSION_SECRET mismatch or data corruption');
		return '';
	}
}
