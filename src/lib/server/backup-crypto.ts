/**
 * Optional passphrase-based AES-256-GCM wrapper for backup ZIP archives.
 *
 * The plain backup ZIP already contains field-encrypted credentials (SMTP
 * password, Telegram bot token, agent HMAC secrets, etc.) under the
 * SESSION_SECRET. This wrapper adds a second, independent layer for the
 * artifact as it travels off-box: a backup file alone — without both the
 * SESSION_SECRET AND the passphrase — yields nothing.
 *
 * Format on disk:
 *   "ITCAKE-ENC-1\n" + salt[16] + iv[12] + tag[16] + ciphertext
 *
 * Key derivation: scrypt(passphrase, salt, N=2^15, r=8, p=1) -> 32 bytes.
 * scrypt is intentionally costly so a leaked encrypted backup resists
 * offline brute force on weak passphrases. N=2^15 is the largest power
 * of two that fits in Node's default 32 MiB scrypt budget; if the
 * operator hasn't bumped --max-old-space-size, this still works.
 */
import crypto from 'node:crypto';

const HEADER = 'ITCAKE-ENC-1\n';
const HEADER_BYTES = Buffer.from(HEADER, 'ascii');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// scrypt with N=2^15, r=8 needs 128 * N * r ≈ 32 MiB. Node default is
// "approximately 32 MiB" — explicitly raise so it doesn't bounce.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const ENCRYPTED_BACKUP_EXT = '.zip.enc';

function deriveKey(passphrase: string, salt: Buffer): Buffer {
	return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_LENGTH, {
		N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM
	});
}

export function isEncryptedBackup(buf: Buffer): boolean {
	return buf.length > HEADER_BYTES.length && buf.subarray(0, HEADER_BYTES.length).equals(HEADER_BYTES);
}

/** Encrypt a backup buffer with the given passphrase. */
export function encryptBackup(plain: Buffer, passphrase: string): Buffer {
	if (!passphrase) throw new Error('encryptBackup: passphrase required');
	const salt = crypto.randomBytes(SALT_LENGTH);
	const iv = crypto.randomBytes(IV_LENGTH);
	const key = deriveKey(passphrase, salt);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([HEADER_BYTES, salt, iv, tag, ct]);
}

/**
 * Decrypt a backup buffer. Returns the inner ZIP bytes on success.
 * Throws if the header doesn't match, the passphrase is wrong, or the
 * GCM tag fails — all failures are indistinguishable to the caller so
 * an attacker can't distinguish "wrong passphrase" from "corrupt data"
 * without doing the full scrypt work themselves.
 */
export function decryptBackup(blob: Buffer, passphrase: string): Buffer {
	if (!passphrase) throw new Error('decryptBackup: passphrase required');
	if (!isEncryptedBackup(blob)) throw new Error('Not an ITCake-encrypted backup');
	let offset = HEADER_BYTES.length;
	const salt = blob.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
	const iv = blob.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
	const tag = blob.subarray(offset, offset + TAG_LENGTH); offset += TAG_LENGTH;
	const ct = blob.subarray(offset);
	const key = deriveKey(passphrase, salt);
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]);
}
