// Callers MUST pair these helpers with `env: safeEnv()` on execFile —
// `resolveBinary` handles only the executable lookup, not the env leg.
import { existsSync } from 'node:fs';

const cache = new Map<string, string>();

function firstExisting(candidates: readonly string[]): string | null {
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

export function resolveBinary(name: string, candidates: readonly string[]): string {
	const cached = cache.get(name);
	if (cached !== undefined) return cached;
	const found = firstExisting(candidates);
	const resolved = found ?? name;
	cache.set(name, resolved);
	return resolved;
}

function resolveBinaryStrict(name: string, candidates: readonly string[]): string | null {
	const cacheKey = `strict:${name}`;
	const cached = cache.get(cacheKey);
	if (cached !== undefined) return cached === '' ? null : cached;
	const found = firstExisting(candidates);
	cache.set(cacheKey, found ?? '');
	return found;
}

const LINUX_PING = ['/bin/ping', '/usr/bin/ping', '/usr/sbin/ping'];
const DARWIN_PING = ['/sbin/ping', '/bin/ping'];
const WINDOWS_PING = ['C:\\Windows\\System32\\ping.exe', 'C:\\Windows\\system32\\PING.EXE'];

const LINUX_GO = ['/usr/local/go/bin/go', '/usr/bin/go', '/usr/local/bin/go', '/snap/bin/go'];
const DARWIN_GO = ['/usr/local/go/bin/go', '/opt/homebrew/bin/go', '/usr/local/bin/go'];

const LINUX_WHICH = ['/usr/bin/which', '/bin/which'];
const DARWIN_WHICH = ['/usr/bin/which'];

const LINUX_SUDO = ['/usr/bin/sudo', '/bin/sudo'];

const LINUX_APT_GET = ['/usr/bin/apt-get'];
const LINUX_DNF = ['/usr/bin/dnf', '/bin/dnf'];
const LINUX_PACMAN = ['/usr/bin/pacman', '/bin/pacman'];
const LINUX_APK = ['/sbin/apk', '/usr/bin/apk', '/usr/sbin/apk'];

const DARWIN_BREW = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
const LINUX_BREW = ['/home/linuxbrew/.linuxbrew/bin/brew'];

const LINUX_GUACD = ['/usr/local/sbin/guacd', '/usr/sbin/guacd', '/usr/bin/guacd'];
const DARWIN_GUACD = ['/opt/homebrew/sbin/guacd', '/opt/homebrew/bin/guacd', '/usr/local/sbin/guacd', '/usr/local/bin/guacd'];

const LINUX_GUACENC = ['/usr/local/bin/guacenc', '/usr/bin/guacenc'];
const DARWIN_GUACENC = ['/opt/homebrew/bin/guacenc', '/usr/local/bin/guacenc'];

function platformCandidates(linux: readonly string[], darwin?: readonly string[], windows?: readonly string[]): readonly string[] {
	if (process.platform === 'darwin') return darwin ?? linux;
	if (process.platform === 'win32') return windows ?? [];
	return linux;
}

export function pingPath(): string {
	return resolveBinary('ping', platformCandidates(LINUX_PING, DARWIN_PING, WINDOWS_PING));
}

export function goPath(): string {
	return resolveBinary('go', platformCandidates(LINUX_GO, DARWIN_GO));
}

export function goPathStrict(): string | null {
	return resolveBinaryStrict('go', platformCandidates(LINUX_GO, DARWIN_GO));
}

export function whichPath(): string {
	return resolveBinary('which', platformCandidates(LINUX_WHICH, DARWIN_WHICH));
}

export function sudoPath(): string {
	return resolveBinary('sudo', platformCandidates(LINUX_SUDO));
}

export function aptGetPath(): string {
	return resolveBinary('apt-get', platformCandidates(LINUX_APT_GET));
}

export function dnfPath(): string {
	return resolveBinary('dnf', platformCandidates(LINUX_DNF));
}

export function pacmanPath(): string {
	return resolveBinary('pacman', platformCandidates(LINUX_PACMAN));
}

export function apkPath(): string {
	return resolveBinary('apk', platformCandidates(LINUX_APK));
}

export function brewPath(): string {
	return resolveBinary('brew', platformCandidates(LINUX_BREW, DARWIN_BREW));
}

export function guacdPath(): string {
	return resolveBinary('guacd', platformCandidates(LINUX_GUACD, DARWIN_GUACD));
}

export function guacdPathStrict(): string | null {
	return resolveBinaryStrict('guacd', platformCandidates(LINUX_GUACD, DARWIN_GUACD));
}

export function guacencPath(): string {
	return resolveBinary('guacenc', platformCandidates(LINUX_GUACENC, DARWIN_GUACENC));
}

export function guacencPathStrict(): string | null {
	return resolveBinaryStrict('guacenc', platformCandidates(LINUX_GUACENC, DARWIN_GUACENC));
}

export function _resetForTests(): void {
	cache.clear();
}
