// PATH-hijack defense for server-side shell-outs (agent build, guacd
// install / status, recording transcode). The web service runs as a
// dedicated user; without this, a non-service local user with write to
// any directory earlier in the inherited PATH could plant a binary that
// the service then runs at full service privilege. Stripping PATH down
// to the system-root-only directories matches the systemd `SecurePath`
// hardening pattern.

const LINUX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const DARWIN_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin';
const WINDOWS_PATH = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0';

export function safePath(): string {
	if (process.platform === 'darwin') return DARWIN_PATH;
	if (process.platform === 'win32') return WINDOWS_PATH;
	return LINUX_PATH;
}

export function safeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...process.env, ...(extra ?? {}), PATH: safePath() };
}
