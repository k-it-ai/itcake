// Sentinel the settings service writes instead of secret values (SMTP password,
// bot tokens, API keys, backup passphrase, …) so they never leave the server.
// A section saved back unchanged therefore still contains the sentinel, which
// the service swaps for the stored secret. Shared between server code and the
// settings UI so both sides compare against the same value.
export const SECRET_MASK = '••••••••';
