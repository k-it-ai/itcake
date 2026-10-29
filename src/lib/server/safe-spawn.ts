const LINUX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const DARWIN_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin';
const WINDOWS_PATH = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0';

function safePath(): string {
	if (process.platform === 'darwin') return DARWIN_PATH;
	if (process.platform === 'win32') return WINDOWS_PATH;
	return LINUX_PATH;
}

export function safeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...process.env, ...(extra ?? {}), PATH: safePath() };
}
