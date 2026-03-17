import { execFile } from 'node:child_process';
import { validateHostname, resolveAndValidate } from './validate-target.js';

export interface CheckResult {
	status: 'up' | 'down' | 'error';
	responseTimeMs: number | null;
	message: string;
}

export async function checkPing(target: string, timeoutMs = 10000): Promise<CheckResult> {
	let pinnedIp: string;
	try {
		validateHostname(target);
		pinnedIp = await resolveAndValidate(target);
	} catch (e) {
		return { status: 'error', responseTimeMs: null, message: e instanceof Error ? e.message : 'Validation failed' };
	}

	return new Promise((resolve) => {
		const timeoutSec = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
		// Ping the resolved IP directly to prevent DNS rebinding
		const args = process.platform === 'darwin'
			? ['-c', '1', '-t', timeoutSec, pinnedIp]
			: ['-c', '1', '-W', timeoutSec, pinnedIp];

		const child = execFile('ping', args, { timeout: timeoutMs + 2000 }, (err, stdout) => {
			if (err) {
				resolve({ status: 'down', responseTimeMs: null, message: `Ping failed: ${err.message.slice(0, 200)}` });
				return;
			}
			const match = stdout.match(/time[=<]([\d.]+)\s*ms/);
			const responseTimeMs = match ? Math.round(parseFloat(match[1])) : null;
			resolve({ status: 'up', responseTimeMs, message: 'OK' });
		});

		setTimeout(() => {
			try { child.kill(); } catch { /* ignore */ }
		}, timeoutMs + 3000).unref();
	});
}
