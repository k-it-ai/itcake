/**
 * Shared cryptographic parameters for SESSION_SECRET-derived field encryption.
 *
 * This module is intentionally plain ESM JavaScript so that both the
 * SvelteKit app (src/lib/server/field-crypto.ts, bundled by Vite) and
 * standalone Node scripts (scripts/rotate-session-secret.mjs) import the
 * exact same values. Duplicated parameter copies previously drifted and made
 * SESSION_SECRET rotation silently produce undecryptable data.
 *
 * Changing any value here makes every existing `enc2:`/`enc3:` blob
 * undecryptable — treat it as a data migration, never a code change.
 */

/** scrypt salt for the master key. */
export const MASTER_KEY_SALT = 'itcake-master-key-v2';

/**
 * scrypt parameters — N: 2^17, r: 8, p: 1, maxmem: 256 MiB.
 * @type {import('node:crypto').ScryptOptions}
 */
export const MASTER_KEY_SCRYPT_OPTS = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/** HKDF info string for per-field keys. */
export const FIELD_KEY_INFO = 'itcake-field-encryption';

/** AEAD algorithm used for every field ciphertext. */
export const FIELD_ALGORITHM = 'aes-256-gcm';

export const KEY_LENGTH = 32;
export const IV_LENGTH = 12;
export const TAG_LENGTH = 16;
export const SALT_LENGTH = 16;
