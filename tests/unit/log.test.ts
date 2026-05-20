/**
 * Tests for the structured logger (lib/server/log.ts).
 * Captures stdout/stderr writes to assert the JSON-line format and
 * level filtering behaviour without depending on a particular test
 * harness for stdout interception.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

let log: typeof import('../../src/lib/server/log.js').log;
let _refresh: typeof import('../../src/lib/server/log.js')._refreshLoggerLevelForTests;

interface Captured { out: string[]; err: string[] }
let captured: Captured;
let restoreStdout: () => void;
let restoreStderr: () => void;

function patchStream(stream: NodeJS.WriteStream, bucket: string[]): () => void {
	const original = stream.write.bind(stream);
	(stream as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
		bucket.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
		return true;
	};
	return () => { (stream as unknown as { write: typeof original }).write = original; };
}

beforeEach(async () => {
	captured = { out: [], err: [] };
	restoreStdout = patchStream(process.stdout, captured.out);
	restoreStderr = patchStream(process.stderr, captured.err);
	if (!log) {
		const mod = await import('../../src/lib/server/log.js');
		log = mod.log;
		_refresh = mod._refreshLoggerLevelForTests;
	}
	process.env.LOG_LEVEL = 'debug';
	_refresh();
});

afterEach(() => {
	restoreStdout();
	restoreStderr();
});

function joined(bucket: string[]): string { return bucket.join(''); }
function lines(bucket: string[]): Record<string, unknown>[] {
	return joined(bucket).split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('log', () => {
	it('emits JSON with ts/level/msg', () => {
		log.info('hello');
		const [rec] = lines(captured.out);
		expect(rec.level).toBe('info');
		expect(rec.msg).toBe('hello');
		expect(typeof rec.ts).toBe('string');
	});

	it('error goes to stderr; info goes to stdout', () => {
		log.info('to-out');
		log.warn('to-err');
		log.error('also-err');
		expect(lines(captured.out).map(r => r.msg)).toEqual(['to-out']);
		expect(lines(captured.err).map(r => r.msg)).toEqual(['to-err', 'also-err']);
	});

	it('merges fields into the record', () => {
		log.info('event', { a: 1, b: 'two' });
		const [rec] = lines(captured.out);
		expect(rec.a).toBe(1);
		expect(rec.b).toBe('two');
	});

	it('extracts Error message into err field', () => {
		log.error('something failed', new Error('boom'));
		const [rec] = lines(captured.err);
		expect(rec.err).toBe('boom');
		expect(rec.errName).toBe('Error');
	});

	it('accepts non-Error err values', () => {
		log.error('failed', 'string reason');
		const [rec] = lines(captured.err);
		expect(rec.err).toBe('string reason');
	});

	it('honours LOG_LEVEL=warn (debug+info suppressed)', () => {
		process.env.LOG_LEVEL = 'warn';
		_refresh();
		log.debug('debug-msg');
		log.info('info-msg');
		log.warn('warn-msg');
		log.error('err-msg');
		expect(lines(captured.out)).toEqual([]);
		expect(lines(captured.err).map(r => r.msg)).toEqual(['warn-msg', 'err-msg']);
	});

	it('survives an unserialisable field (no throw, falls back marker)', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		log.info('cyclic', cyclic);
		const [rec] = lines(captured.out);
		expect(rec._serializeError).toBe(true);
		expect(rec.msg).toBe('cyclic');
	});
});
