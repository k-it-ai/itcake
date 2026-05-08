import { getSetting, setSetting } from '$lib/server/db.js';
import { sendEmail } from '$services/emails.js';
import { escapeHtml, sanitizeHeader } from '$lib/server/sanitize.js';
import { persistExpiryNotifiedAt } from '$services/monitors.js';
import { serverT } from '$lib/i18n/server.js';
import { TELEGRAM_BOT_TOKEN_RE } from '$lib/validators-settings.js';
import type { Monitor, MonitorStatus, UptimeSettings, GeneralSettings } from '$lib/types.js';

function persistNotifyError(channel: 'telegram' | 'email', errorMsg: string): void {
	try {
		const settings = getSetting<UptimeSettings & Record<string, unknown>>('uptime');
		settings.lastNotifyError = { channel, message: errorMsg.slice(0, 500), at: new Date().toISOString() };
		setSetting('uptime', settings);
	} catch { /* best effort — console.error is the primary fallback */ }
}

function clearNotifyError(channel: 'telegram' | 'email'): void {
	try {
		const settings = getSetting<UptimeSettings & { lastNotifyError?: { channel: 'telegram' | 'email' } }>('uptime');
		if (settings.lastNotifyError && settings.lastNotifyError.channel === channel) {
			delete settings.lastNotifyError;
			setSetting('uptime', settings);
		}
	} catch { /* best effort */ }
}

function dispatch(channel: 'telegram' | 'email', label: string, promise: Promise<unknown>): void {
	promise
		.then(() => clearNotifyError(channel))
		.catch((e) => {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`${label}:`, msg);
			persistNotifyError(channel, msg);
		});
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

		dispatch('telegram', 'Telegram notification failed',
			sendTelegramMessage(settings.telegram.botToken, settings.telegram.chatId, lines.join('\n')));
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

		dispatch('email', 'Email notification failed', sendEmail({ to: settings.alertEmail, subject, body }));
	}
}

export async function notifyExpiryWarning(
	monitor: Monitor,
	type: 'domain' | 'ssl',
	daysRemaining: number
): Promise<void> {
	const dedupeKey = `${monitor.id}:${type}`;
	const lastNotified = expiryNotifiedAt.get(dedupeKey)
		?? (type === 'domain' ? monitor.lastExpiryNotifiedDomain : monitor.lastExpiryNotifiedSsl);
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
		dispatch('telegram', 'Telegram expiry notification failed',
			sendTelegramMessage(settings.telegram.botToken, settings.telegram.chatId, text));
	}

	if (settings.emailAlerts && settings.alertEmail) {
		dispatch('email', 'Email expiry notification failed', sendEmail({
			to: settings.alertEmail,
			subject: sanitizeHeader(t('notify.subjectExpiry', { label, name: monitor.name })),
			body: t('notify.emailExpiry', { label, name: monitor.name, host: monitor.domain, days: daysRemaining })
		}));
	}

	const now = Date.now();
	expiryNotifiedAt.set(dedupeKey, now);
	persistExpiryNotifiedAt(monitor.id, type, now);
}

const TG_MAX_LEN = 4000;
function capTelegramText(text: string): string {
	if (text.length <= TG_MAX_LEN) return text;
	const truncated = text.slice(0, TG_MAX_LEN - 1) + '…';
	const openCount = (s: string, t: string) => (s.match(new RegExp(`<${t}>`, 'g')) || []).length;
	const closeCount = (s: string, t: string) => (s.match(new RegExp(`</${t}>`, 'g')) || []).length;
	let out = truncated;
	for (const tag of ['b', 'i', 'u', 'code']) {
		const diff = openCount(truncated, tag) - closeCount(truncated, tag);
		if (diff > 0) out += `</${tag}>`.repeat(diff);
	}
	return out;
}

export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
	if (!TELEGRAM_BOT_TOKEN_RE.test(botToken)) throw new Error('Invalid Telegram bot token shape');
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text: capTelegramText(text),
			parse_mode: 'HTML',
			disable_web_page_preview: true
		}),
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
