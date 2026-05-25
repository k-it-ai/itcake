import { env } from '$env/dynamic/private';
import { stripSecrets, redactSensitiveInput } from './ai/compaction.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

type Fields = Record<string, unknown>;

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredMin(): number {
	// `$env/dynamic/private` may be stubbed under vitest; read process.env directly.
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
		line = JSON.stringify({ ts: rec.ts, level, msg, _serializeError: true });
	}
	if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
	else process.stdout.write(line + '\n');
}

function safeRedact(fields: Fields): Fields | undefined {
	try { return redactSensitiveInput(fields); } catch { return fields; }
}

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

export function _refreshLoggerLevelForTests(): void { minRank = configuredMin(); }
