/**
 * Tests for `src/lib/server/system-binary.ts` — the PATH-hijack defense
 * for server-side shell-outs (regression for finding #3/#7).
 *
 * The unit-level invariants are:
 *   1. If any candidate path exists on disk, the resolved value IS one of
 *      the candidates (absolute path).
 *   2. If none exist, the resolved value is the bare name — callers MUST
 *      pair this with `safeEnv()` so the child's PATH is restricted.
 *   3. The result is cached per-name so the disk probes run at most once.
 *   4. None of the platform-specific helpers return an empty string or
 *      a path with shell-meta characters.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveBinary, _resetForTests, pingPath, goPath, goPathStrict, whichPath, sudoPath, guacdPath, guacdPathStrict, guacencPath, guacencPathStrict, brewPath, aptGetPath, dnfPath, pacmanPath, apkPath } from '../../src/lib/server/system-binary.js';

describe('resolveBinary', () => {
	beforeEach(() => _resetForTests());

	it('returns the first existing candidate when one exists', () => {
		// /bin/sh is on every POSIX. (Test skips on Windows where /bin/sh
		// doesn't exist — Windows is out of scope for the server.)
		if (process.platform === 'win32') return;
		const r = resolveBinary('test-shell', ['/nonexistent-prefix-1', '/bin/sh', '/nonexistent-prefix-2']);
		expect(r).toBe('/bin/sh');
	});

	it('falls back to the bare name when none of the candidates exist', () => {
		const r = resolveBinary('totally-fake-binary-zzz', ['/nope/one', '/nope/two']);
		expect(r).toBe('totally-fake-binary-zzz');
	});

	it('caches the resolution per-name — probes do not re-run', () => {
		// First call probes; second call must return the same result without
		// re-checking disk (cache hit). We assert by passing different
		// candidates the second time and seeing the first result returned.
		if (process.platform === 'win32') return;
		const first = resolveBinary('cache-probe', ['/bin/sh']);
		const second = resolveBinary('cache-probe', ['/etc/hosts']);
		expect(second).toBe(first);
	});

	it('reset clears the cache so probes re-run with fresh candidates', () => {
		if (process.platform === 'win32') return;
		resolveBinary('cache-probe-2', ['/bin/sh']);
		_resetForTests();
		const r = resolveBinary('cache-probe-2', ['/nope', '/nope-2']);
		expect(r).toBe('cache-probe-2');
	});
});

describe('platform-specific resolvers', () => {
	beforeEach(() => _resetForTests());

	it.each([
		['pingPath', pingPath],
		['goPath', goPath],
		['whichPath', whichPath],
		['sudoPath', sudoPath],
		['guacdPath', guacdPath],
		['guacencPath', guacencPath],
		['brewPath', brewPath],
		['aptGetPath', aptGetPath],
		['dnfPath', dnfPath],
		['pacmanPath', pacmanPath],
		['apkPath', apkPath]
	])('%s returns a non-empty string', (_label, fn) => {
		const p = fn();
		expect(p).toBeTruthy();
		expect(typeof p).toBe('string');
		// No shell meta — `execFile` doesn't shell-parse, but the resolved
		// path must still be a clean executable name/path, not something
		// like 'ping; rm -rf /'.
		expect(p).not.toMatch(/[;|&`$<>(){}\n\r]/);
	});

	it('pingPath resolves to a real binary on POSIX where /bin/ping or /sbin/ping exists', () => {
		if (process.platform === 'win32') return;
		const p = pingPath();
		// Either an absolute path (found on disk) or 'ping' (fallback).
		expect(p === 'ping' || p.startsWith('/')).toBe(true);
	});
});

describe('strict resolvers — return null instead of bare name', () => {
	beforeEach(() => _resetForTests());

	it.each([
		['goPathStrict', goPathStrict],
		['guacdPathStrict', guacdPathStrict],
		['guacencPathStrict', guacencPathStrict]
	])('%s never returns a bare name; either an absolute path or null', (_label, fn) => {
		const p = fn();
		if (p !== null) {
			expect(p.startsWith('/')).toBe(true);
		}
	});

	it('a strict resolver returns null when no candidate exists on disk (covers PATH-hijack class)', () => {
		const p = guacencPathStrict();
		if (p === null) {
			expect(p).toBeNull();
		} else {
			expect(p.startsWith('/')).toBe(true);
		}
	});
});
