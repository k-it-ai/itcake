import { env } from '$env/dynamic/private';
import { stripSecrets, redactSensitiveInput } from './ai/compaction.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

type Fields = Record<string, unknown>;

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredMin(): number {
	// Read process.env directly: `$env/dynamic/private` may be stubbed under
	// vitest. Fall back to env.NODE_ENV (set by the runtime) for the default.
	const raw = (process.env.LOG_LEVEL || (env.NODE_ENV === 'development' ? 'debug' : 'info')).toLowerCase();
	return LEVEL_RANK[raw as Level] ?? LEVEL_RANK.info;
}

let minRank = configuredMin();

function emit(level: Level, msg: string, fields?: Fields): void {
	if (LEVEL_RANK[level] < minRank) return;
	const rec = { ts: new Date().toISOString(), level, msg, ...(fields ?? {}) };
	let line: string;
	try {
		line = JSON.stringify(rec);
	} catch {
		// One field is unserialisable — fall back to a stringified error message
		// rather than crash the logging path itself.
		line = JSON.stringify({ ts: rec.ts, level, msg, _serializeError: true });
	}
	// Stay on stderr for errors/warnings (operators tail stderr); stdout for info.
	if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
	else process.stdout.write(line + '\n');
}

// `redactSensitiveInput` walks the object eagerly and will overflow on
// cycles. Logger callers can (and historically do) pass cyclic objects
// — the unserialisable-input branch in `emit` is designed to handle
// that — so a redact failure falls back to the cycle-safe placeholder
// rather than crashing the call. The non-redacted path stays for that
// one record (it's then JSON.stringify'd, which also fails, which then
// trips the `_serializeError: true` marker).
function safeRedact(fields: Fields): Fields | undefined {
	try { return redactSensitiveInput(fields); } catch { return fields; }
}

// The `err`/`stack` strings on log.error AND the operator-supplied `fields`
// object run through the secret-stripper before emit. Without this, code
// paths like `log.error('decrypt failed', e, { agentId, ciphertext })`
// could leak token-shaped or enc3:-shaped secrets to stdout/stderr, which
// is the same egress point a SIEM or aggregator tails.
export const log = {
	debug(msg: string, fields?: Fields): void { emit('debug', stripSecrets(msg), fields ? safeRedact(fields) : undefined); },
	info(msg: string, fields?: Fields): void { emit('info', stripSecrets(msg), fields ? safeRedact(fields) : undefined); },
	warn(msg: string, fields?: Fields): void { emit('warn', stripSecrets(msg), fields ? safeRedact(fields) : undefined); },
	error(msg: string, err?: unknown, fields?: Fields): void {
		const errFields = err === undefined ? {} : (err instanceof Error
			? { err: stripSecrets(err.message), errName: err.name, stack: env.NODE_ENV === 'development' && err.stack ? stripSecrets(err.stack) : undefined }
			: { err: stripSecrets(String(err)) });
		emit('error', stripSecrets(msg), { ...errFields, ...(fields ? safeRedact(fields) : {}) });
	}
};

// Test-only: re-evaluate LOG_LEVEL after the env was changed by a test.
export function _refreshLoggerLevelForTests(): void { minRank = configuredMin(); }
