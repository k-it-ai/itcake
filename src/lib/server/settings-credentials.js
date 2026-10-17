/**
 * Canonical registry of encrypted settings credentials.
 *
 * Shared between src/lib/server/db.ts (write/read/repair paths) and
 * scripts/rotate-session-secret.mjs (key rotation) so the label list and the
 * AAD format can never drift apart again. Plain ESM JavaScript so the
 * standalone Node script can import it without a TypeScript loader.
 */

/**
 * @typedef {object} SettingsCredentialSpec
 * @property {string} key settings row key
 * @property {string[]} path path inside the JSON value
 * @property {string} label canonical AAD label (`<label>:1` is the AAD)
 */

/**
 * Write + read + repair + rotation paths must all iterate this list —
 * a missed label stays wrapped under the old key (or enc2) forever.
 * @type {SettingsCredentialSpec[]}
 */
export const SETTINGS_CREDENTIALS = [
	{ key: 'emails', path: ['smtp', 'pass'], label: 'emails.smtp.pass' },
	{ key: 'uptime', path: ['telegram', 'botToken'], label: 'uptime.telegram.botToken' },
	{ key: 'ai', path: ['apiKey'], label: 'ai.apiKey' },
	{ key: 'backup', path: ['encryptionPassphrase'], label: 'backup.encryptionPassphrase' },
	{ key: 'backup', path: ['offsite', 's3', 'secretAccessKey'], label: 'backup.offsite.s3.secretAccessKey' },
	{ key: 'backup', path: ['offsite', 'webdav', 'password'], label: 'backup.offsite.webdav.password' },
	{ key: 'rmm', path: ['updateManifestPrivateKey'], label: 'rmm.updateManifestPrivateKey' },
	{ key: 'telemetry', path: ['errorReportingDsn'], label: 'telemetry.errorReportingDsn' }
];

/** Canonical AAD for each credential label. @type {Record<string, string>} */
export const SETTINGS_CREDENTIAL_AADS = Object.fromEntries(
	SETTINGS_CREDENTIALS.map((c) => [c.label, `${c.label}:1`])
);
