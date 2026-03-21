import { getSetting, setSetting } from '$lib/server/db.js';
import { sendEmail } from '$services/emails.js';
import { escapeHtml, sanitizeHeader } from '$lib/server/sanitize.js';
import { persistExpiryNotifiedAt } from '$services/monitors.js';
import { serverT } from '$lib/i18n/server.js';
import type { Monitor, MonitorStatus, UptimeSettings, GeneralSettings } from '$lib/types.js';

/**
 * Persist the last notification error so the UI can warn the user when alerts are broken.
 * Stored in the uptime settings blob under `lastNotifyError`.
 * Cleared on next successful notification delivery.
 */
function persistNotifyError(channel: 'telegram' | 'email', errorMsg: string): void {
	try {
		const settings = getSetting<UptimeSettings & Record<string, unknown>>('uptime');
		settings.lastNotifyError = { channel, message: errorMsg.slice(0, 500), at: new Date().toISOString() };
		setSetting('uptime', settings);
	} catch { /* best effort — console.error is the primary fallback */ }
}

function clearNotifyError(): void {
	try {
		const settings = getSetting<UptimeSettings & Record<string, unknown>>('uptime');
		if (settings.lastNotifyError) {
			delete settings.lastNotifyError;
			setSetting('uptime', settings);
		}
	} catch { /* best effort */ }
}

function getT() {
	const lang = getSetting<GeneralSettings>('general')?.language || 'en';
	return serverT(lang);
}

function formatLocalTime(): string {
	const tz = getSetting<GeneralSettings>('general')?.timezone || 'UTC';
	try {
		return new Date().toLocaleString('en-GB', { timeZone: tz, hour12: false }).replace(',', '');
	} catch {
		return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
	}
}

const expiryNotifiedAt = new Map<string, number>();
const EXPIRY_NOTIFY_COOLDOWN = 24 * 60 * 60 * 1000;

/** Remove cached expiry notification timestamps for a deleted monitor. */
export function clearExpiryNotifiedCache(monitorId: string): void {
	for (const key of expiryNotifiedAt.keys()) {
		if (key.startsWith(monitorId + ':')) {
			expiryNotifiedAt.delete(key);
		}
	}
}

export async function notifyStatusChange(
	monitor: Monitor,
	oldStatus: MonitorStatus,
	newStatus: MonitorStatus,
	failedChecks: string[]
): Promise<void> {
	const settings = getSetting<UptimeSettings>('uptime');
	if (!settings) return;

	const t = getT();
	const isDown = newStatus === 'down' || newStatus === 'error';
	const emoji = isDown ? '\u{1F534}' : '\u{1F7E2}';
	const label = isDown ? t('notify.isDown') : t('notify.isUp');

	if (settings.telegram.enabled && settings.telegram.botToken && settings.telegram.chatId) {
		const identifier = monitor.domain || monitor.ip;
		const lines = [
			`${emoji} <b>${escapeHtml(monitor.name)}</b> ${label}`,
			`${t('notify.host')}: <code>${escapeHtml(identifier)}</code>`,
		];
		if (isDown && failedChecks.length > 0) {
			for (const check of failedChecks) {
				const [type, ...rest] = check.split(': ');
				lines.push(`\u{2022} ${escapeHtml(type)}: ${escapeHtml(rest.join(': '))}`);
			}
		}
		if (!isDown && oldStatus === 'down') {
			lines.push(`\u{2705} ${t('notify.serviceRecovered')}`);
		}
		lines.push(`\u{1F552} ${formatLocalTime()}`);

		sendTelegramMessage(settings.telegram.botToken, settings.telegram.chatId, lines.join('\n'))
			.then(() => clearNotifyError())
			.catch(e => {
				const msg = e instanceof Error ? e.message : String(e);
				console.error('Telegram notification failed:', msg);
				persistNotifyError('telegram', msg);
			});
	}

	if (settings.emailAlerts && settings.alertEmail) {
		const identifier = monitor.domain || monitor.ip;
		const time = formatLocalTime();
		const subject = sanitizeHeader(isDown
			? t('notify.subjectDown', { name: monitor.name })
			: t('notify.subjectUp', { name: monitor.name }));
		const body = isDown
			? t('notify.emailDown', { name: monitor.name, host: identifier, status: newStatus, checks: failedChecks.join(', '), time })
			: t('notify.emailUp', { name: monitor.name, host: identifier, time });

		sendEmail({ to: settings.alertEmail, subject, body })
			.then(() => clearNotifyError())
			.catch(e => {
				const msg = e instanceof Error ? e.message : String(e);
				console.error('Email notification failed:', msg);
				persistNotifyError('email', msg);
			});
	}
}

export async function notifyExpiryWarning(
	monitor: Monitor,
	type: 'domain' | 'ssl',
	daysRemaining: number
): Promise<void> {
	const dedupeKey = `${monitor.id}:${type}`;
	const lastNotified = expiryNotifiedAt.get(dedupeKey)
		?? (monitor as unknown as Record<string, unknown>)[`lastExpiryNotified_${type}`] as number | undefined;
	if (lastNotified && Date.now() - lastNotified < EXPIRY_NOTIFY_COOLDOWN) return;

	const settings = getSetting<UptimeSettings>('uptime');
	if (!settings) return;

	const t = getT();
	const label = type === 'domain' ? t('notify.domain') : t('notify.sslCertificate');
	const emoji = '\u{26A0}\u{FE0F}';

	if (settings.telegram.enabled && settings.telegram.botToken && settings.telegram.chatId) {
		const text = [
			`${emoji} <b>${escapeHtml(monitor.name)}</b> — ${t('notify.expiryTitle', { label })}`,
			`${t('notify.host')}: <code>${escapeHtml(monitor.domain)}</code>`,
			`\u{1F4C5} ${t('notify.expiresInDays', { days: daysRemaining })}`,
			`\u{1F552} ${formatLocalTime()}`
		].join('\n');
		sendTelegramMessage(settings.telegram.botToken, settings.telegram.chatId, text)
			.then(() => clearNotifyError())
			.catch(e => {
				const msg = e instanceof Error ? e.message : String(e);
				console.error('Telegram expiry notification failed:', msg);
				persistNotifyError('telegram', msg);
			});
	}

	if (settings.emailAlerts && settings.alertEmail) {
		sendEmail({
			to: settings.alertEmail,
			subject: sanitizeHeader(t('notify.subjectExpiry', { label, name: monitor.name })),
			body: t('notify.emailExpiry', { label, name: monitor.name, host: monitor.domain, days: daysRemaining })
		})
			.then(() => clearNotifyError())
			.catch(e => {
				const msg = e instanceof Error ? e.message : String(e);
				console.error('Email expiry notification failed:', msg);
				persistNotifyError('email', msg);
			});
	}

	const now = Date.now();
	expiryNotifiedAt.set(dedupeKey, now);
	persistExpiryNotifiedAt(monitor.id, type, now);
}

export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
		signal: AbortSignal.timeout(10000),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Telegram API error ${res.status}: ${body.slice(0, 200)}`);
	}
}

export async function testTelegram(botToken: string, chatId: string): Promise<{ success: boolean; botName?: string; error?: string }> {
	try {
		const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
			signal: AbortSignal.timeout(10000)
		});
		if (!meRes.ok) return { success: false, error: 'Invalid bot token' };
		const me = await meRes.json() as { result?: { first_name?: string } };

		const t = getT();
		await sendTelegramMessage(botToken, chatId, `\u{2705} ${t('notify.telegramConnected')}`);
		return { success: true, botName: me.result?.first_name };
	} catch (e) {
		return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
	}
}
