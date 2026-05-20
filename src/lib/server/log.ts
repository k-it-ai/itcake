import { env } from '$env/dynamic/private';

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

export const log = {
	debug(msg: string, fields?: Fields): void { emit('debug', msg, fields); },
	info(msg: string, fields?: Fields): void { emit('info', msg, fields); },
	warn(msg: string, fields?: Fields): void { emit('warn', msg, fields); },
	error(msg: string, err?: unknown, fields?: Fields): void {
		const errFields = err === undefined ? {} : (err instanceof Error
			? { err: err.message, errName: err.name, stack: env.NODE_ENV === 'development' ? err.stack : undefined }
			: { err: String(err) });
		emit('error', msg, { ...errFields, ...(fields ?? {}) });
	}
};

// Test-only: re-evaluate LOG_LEVEL after the env was changed by a test.
export function _refreshLoggerLevelForTests(): void { minRank = configuredMin(); }
