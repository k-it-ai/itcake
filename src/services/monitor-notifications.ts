import { getSetting } from '$lib/server/db.js';
import { sendEmail } from '$services/emails.js';
import { escapeHtml, sanitizeHeader } from '$lib/server/sanitize.js';
import { persistExpiryNotifiedAt } from '$services/monitors.js';
import type { Monitor, MonitorStatus, UptimeSettings, GeneralSettings } from '$lib/types.js';

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

export async function notifyStatusChange(
	monitor: Monitor,
	oldStatus: MonitorStatus,
	newStatus: MonitorStatus,
	failedChecks: string[]
): Promise<void> {
	const settings = getSetting<UptimeSettings>('uptime');
	if (!settings) return;

	const isDown = newStatus === 'down' || newStatus === 'error';
	const emoji = isDown ? '\u{1F534}' : '\u{1F7E2}';
	const label = isDown ? 'DOWN' : 'UP';

	if (settings.telegram.enabled && settings.telegram.botToken && settings.telegram.chatId) {
		const identifier = monitor.domain || monitor.ip;
		const lines = [
			`${emoji} <b>${escapeHtml(monitor.name)}</b> is <b>${label}</b>`,
			`Host: <code>${escapeHtml(identifier)}</code>`,
		];
		if (isDown && failedChecks.length > 0) {
			for (const check of failedChecks) {
				const [type, ...rest] = check.split(': ');
				lines.push(`\u{2022} ${escapeHtml(type)}: ${escapeHtml(rest.join(': '))}`);
			}
		}
		if (!isDown && oldStatus === 'down') {
			lines.push('\u{2705} Service recovered');
		}
		lines.push(`\u{1F552} ${formatLocalTime()}`);

		sendTelegramMessage(settings.telegram.botToken, settings.telegram.chatId, lines.join('\n'))
			.catch(e => console.error('Telegram notification failed:', e instanceof Error ? e.message : e));
	}

	if (settings.emailAlerts && settings.alertEmail) {
		const subject = sanitizeHeader(`[${label}] ${monitor.name}`);
		const identifier = monitor.domain || monitor.ip;
		const time = formatLocalTime();
		const body = isDown
			? `Monitor "${monitor.name}" (${identifier}) is ${newStatus}.\n\nFailed checks: ${failedChecks.join(', ')}\nTime: ${time}`
			: `Monitor "${monitor.name}" (${identifier}) is back up.\nTime: ${time}`;

		sendEmail({ to: settings.alertEmail, subject, body })
			.catch(e => console.error('Email notification failed:', e instanceof Error ? e.message : e));
	}
}

export async function notifyExpiryWarning(
	monitor: Monitor,
	type: 'domain' | 'ssl',
	daysRemaining: number
): Promise<void> {
	const dedupeKey = `${monitor.id}:${type}`;
	const lastNotified = expiryNotifiedAt.get(dedupeKey)
		// Cold-start fallback: read persisted timestamp from monitor data
		?? (monitor as unknown as Record<string, unknown>)[`lastExpiryNotified_${type}`] as number | undefined;
	if (lastNotified && Date.now() - lastNotified < EXPIRY_NOTIFY_COOLDOWN) return;

	const settings = getSetting<UptimeSettings>('uptime');
	if (!settings) return;

	const label = type === 'domain' ? 'Domain' : 'SSL Certificate';
	const emoji = '\u{26A0}\u{FE0F}';

	if (settings.telegram.enabled && settings.telegram.botToken && settings.telegram.chatId) {
		const text = [
			`${emoji} <b>${escapeHtml(monitor.name)}</b> — ${label} Expiry`,
			`Host: <code>${escapeHtml(monitor.domain)}</code>`,
			`\u{1F4C5} Expires in <b>${daysRemaining}</b> day(s)`,
			`\u{1F552} ${formatLocalTime()}`
		].join('\n');
		sendTelegramMessage(settings.telegram.botToken, settings.telegram.chatId, text)
			.catch(e => console.error('Telegram expiry notification failed:', e instanceof Error ? e.message : e));
	}

	if (settings.emailAlerts && settings.alertEmail) {
		sendEmail({
			to: settings.alertEmail,
			subject: sanitizeHeader(`[Warning] ${label} expiring — ${monitor.name}`),
			body: `${label} for "${monitor.name}" (${monitor.domain}) expires in ${daysRemaining} day(s).`
		}).catch(e => console.error('Email expiry notification failed:', e instanceof Error ? e.message : e));
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

		await sendTelegramMessage(botToken, chatId, `\u{2705} ITCake uptime alerts connected!`);
		return { success: true, botName: me.result?.first_name };
	} catch (e) {
		return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
	}
}

