import crypto from 'node:crypto';

const HEADER_V1 = 'ITCAKE-ENC-1\n';
const HEADER_V2 = 'ITCAKE-ENC-2\n';
const HEADER_V1_BYTES = Buffer.from(HEADER_V1, 'ascii');
const HEADER_V2_BYTES = Buffer.from(HEADER_V2, 'ascii');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_N_V1 = 1 << 15;
const SCRYPT_N_V2 = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export const ENCRYPTED_BACKUP_EXT = '.zip.enc';

function deriveKey(passphrase: string, salt: Buffer, N: number): Buffer {
	return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_LENGTH, {
		N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM
	});
}

export function isEncryptedBackup(buf: Buffer): boolean {
	if (buf.length <= HEADER_V1_BYTES.length) return false;
	const head = buf.subarray(0, HEADER_V1_BYTES.length);
	return head.equals(HEADER_V1_BYTES) || head.equals(HEADER_V2_BYTES);
}

export function encryptBackup(plain: Buffer, passphrase: string): Buffer {
	if (!passphrase) throw new Error('encryptBackup: passphrase required');
	const salt = crypto.randomBytes(SALT_LENGTH);
	const iv = crypto.randomBytes(IV_LENGTH);
	const key = deriveKey(passphrase, salt, SCRYPT_N_V2);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([HEADER_V2_BYTES, salt, iv, tag, ct]);
}

export function decryptBackup(blob: Buffer, passphrase: string): Buffer {
	if (!passphrase) throw new Error('decryptBackup: passphrase required');
	if (!isEncryptedBackup(blob)) throw new Error('Not an ITCake-encrypted backup');
	const head = blob.subarray(0, HEADER_V1_BYTES.length);
	let N: number;
	if (head.equals(HEADER_V2_BYTES)) {
		N = SCRYPT_N_V2;
	} else if (head.equals(HEADER_V1_BYTES)) {
		N = SCRYPT_N_V1;
	} else {
		throw new Error('Unknown ITCake backup header version');
	}
	let offset = HEADER_V1_BYTES.length;
	const salt = blob.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
	const iv = blob.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
	const tag = blob.subarray(offset, offset + TAG_LENGTH); offset += TAG_LENGTH;
	const ct = blob.subarray(offset);
	const key = deriveKey(passphrase, salt, N);
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]);
}
