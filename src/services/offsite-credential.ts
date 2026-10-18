import { NODE_ENV } from '$app/env/private';
import { decryptField, isEncryptedField } from '#lib/server/field-crypto.js';

/**
 * Credentials from backup settings arrive already decrypted (getSetting),
 * so plaintext is normal — in production too. Ciphertext here means the
 * decrypt wiring missed this label: fail loudly in prod, decrypt in dev.
 */
export function resolveOffsiteCredential(value: string, nodeEnv: string | undefined = NODE_ENV): string {
	if (!value) return value;
	if (isEncryptedField(value)) {
		if (nodeEnv === 'production') {
			throw new Error('off-site credential is still ciphertext at use site; check decryptSettingsFields wiring');
		}
		return decryptField(value);
	}
	return value;
}
