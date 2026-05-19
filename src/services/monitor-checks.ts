import { getEnabledMonitors, recordCheckResult, updateMonitorAfterCheck } from './monitors.js';
import { notifyStatusChange, notifyExpiryWarning } from './monitor-notifications.js';
import { emitCheckComplete } from '$lib/server/monitor-events.js';
import { checkPing } from '$lib/server/checks/ping.js';
import { checkHttp } from '$lib/server/checks/http.js';
import { checkSsl } from '$lib/server/checks/ssl.js';
import { checkDomainExpiry } from '$lib/server/checks/rdap.js';
import type { Monitor, MonitorStatus } from '$lib/types.js';
import type { CheckResult } from '$lib/server/checks/ping.js';

let running = false;
let runStartedAt = 0;
let dailyRunning = false;
let dailyRunStartedAt = 0;

const CHECK_TIMEOUT_MS = 120_000;

export async function runChecks(): Promise<void> {
	if (running && Date.now() - runStartedAt > CHECK_TIMEOUT_MS) {
		console.warn('[monitor-checks] Force-resetting hung check run');
		running = false;
	}
	if (running) return; // prevent overlap
	running = true;
	runStartedAt = Date.now();
	try {
		const monitors = getEnabledMonitors();
		for (const monitor of monitors) {
			try {
				await runMonitorChecks(monitor);
			} catch (e) {
				console.error(`Check failed for monitor ${monitor.id}:`, e instanceof Error ? e.message : e);
			}
		}
		emitCheckComplete();
	} finally {
		running = false;
	}
}

async function runMonitorChecks(monitor: Monitor): Promise<void> {
	const results: { type: string; result: CheckResult }[] = [];

	const promises: Promise<void>[] = [];

	if (monitor.checks.ping) {
		const pingTarget = monitor.ip || monitor.domain;
		if (pingTarget) {
			promises.push(
				checkPing(pingTarget).then(r => {
					results.push({ type: 'ping', result: r });
					recordCheckResult(monitor.id, 'ping', r.status, r.responseTimeMs, r.message);
				})
			);
		}
	}

	if (monitor.checks.http) {
		const httpTarget = monitor.domain || monitor.ip;
		if (httpTarget) {
			promises.push(
				checkHttp(httpTarget, monitor.httpExpectedStatus).then(r => {
					results.push({ type: 'http', result: r });
					recordCheckResult(monitor.id, 'http', r.status, r.responseTimeMs, r.message);
				})
			);
		}
	}

	await Promise.allSettled(promises);

	const oldStatus = monitor.status;
	let newStatus: MonitorStatus;
	const failedChecks: string[] = [];

	if (results.length === 0) {
		newStatus = oldStatus; // no applicable checks ran
	} else {
		const hasDown = results.some(r => r.result.status === 'down');
		const hasError = results.some(r => r.result.status === 'error');
		if (hasDown) {
			newStatus = 'down';
			failedChecks.push(...results.filter(r => r.result.status === 'down').map(r => `${r.type}: ${r.result.message}`));
		} else if (hasError) {
			newStatus = 'error';
			failedChecks.push(...results.filter(r => r.result.status === 'error').map(r => `${r.type}: ${r.result.message}`));
		} else {
			newStatus = 'up';
		}
	}

	const httpResult = results.find(r => r.type === 'http');
	const pingResult = results.find(r => r.type === 'ping');
	const responseTimeMs = httpResult?.result.responseTimeMs ?? pingResult?.result.responseTimeMs ?? null;
	const lastError = newStatus !== 'up' ? failedChecks.join('; ') : null;

	updateMonitorAfterCheck(monitor.id, newStatus, {
		lastResponseTimeMs: responseTimeMs,
		lastError,
	});

	if (oldStatus !== newStatus && oldStatus !== 'pending') {
		notifyStatusChange(monitor, oldStatus, newStatus, failedChecks)
			.catch(e => console.error(`[monitor-checks] notifyStatusChange failed for ${monitor.id}:`, e instanceof Error ? e.message : e));
	}
}

export async function runDailyChecks(): Promise<void> {
	if (dailyRunning && Date.now() - dailyRunStartedAt > CHECK_TIMEOUT_MS * 5) {
		console.warn('[monitor-checks] Force-resetting hung daily check run');
		dailyRunning = false;
	}
	if (dailyRunning) return;
	dailyRunning = true;
	dailyRunStartedAt = Date.now();
	try {
		const monitors = getEnabledMonitors();

		for (const monitor of monitors) {
			try {
				if (monitor.checks.domainExpiry) {
					await runDomainExpiryCheck(monitor);
				}
			} catch (e) {
				console.error(`Domain expiry check failed for ${monitor.id}:`, e instanceof Error ? e.message : e);
			}

			try {
				if (monitor.checks.sslExpiry) {
					await runSslExpiryCheck(monitor);
				}
			} catch (e) {
				console.error(`SSL expiry check failed for ${monitor.id}:`, e instanceof Error ? e.message : e);
			}
		}
	} finally {
		dailyRunning = false;
	}
}

async function runDomainExpiryCheck(monitor: Monitor): Promise<void> {
	if (!monitor.domain) return;
	try {
		const result = await checkDomainExpiry(monitor.domain);
		recordCheckResult(monitor.id, 'domain_expiry', 'up', null, `Expires: ${result.expiryDate} (${result.daysRemaining}d)`);
		updateMonitorAfterCheck(monitor.id, monitor.status, { domainExpiryDate: result.expiryDate });

		if (result.daysRemaining <= monitor.domainExpiryThresholdDays) {
			notifyExpiryWarning(monitor, 'domain', result.daysRemaining)
				.catch(e => console.error(`[monitor-checks] notifyExpiryWarning failed for ${monitor.id}:`, e instanceof Error ? e.message : e));
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		recordCheckResult(monitor.id, 'domain_expiry', 'error', null, msg);
	}
}

async function runSslExpiryCheck(monitor: Monitor): Promise<void> {
	if (!monitor.domain) return;
	try {
		const result = await checkSsl(monitor.domain);
		recordCheckResult(monitor.id, 'ssl_expiry', 'up', null, `Expires: ${result.expiryDate} (${result.daysRemaining}d)`);
		updateMonitorAfterCheck(monitor.id, monitor.status, { sslExpiryDate: result.expiryDate });

		if (result.daysRemaining <= monitor.sslExpiryThresholdDays) {
			notifyExpiryWarning(monitor, 'ssl', result.daysRemaining)
				.catch(e => console.error(`[monitor-checks] notifyExpiryWarning failed for ${monitor.id}:`, e instanceof Error ? e.message : e));
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		recordCheckResult(monitor.id, 'ssl_expiry', 'error', null, msg);
	}
}

