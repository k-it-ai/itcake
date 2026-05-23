import { getSetting, setSetting } from '$lib/server/db.js';
import { sendEmail } from '$services/emails.js';
import { escapeHtml, sanitizeHeader } from '$lib/server/sanitize.js';
import { persistExpiryNotifiedAt } from '$services/monitors.js';
import { serverT } from '$lib/i18n/server.js';
import { TELEGRAM_BOT_TOKEN_RE } from '$lib/validators-settings.js';
import { pinnedHttpsRequest } from '$lib/server/pinned-https.js';
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
		// `sanitizeHeader` strips control chars from BOTH the subject AND
		// every value substituted into the body. Monitor names + identifiers
		// are operator-set but lack a server-side `^[^\r\n\0]+$` validator;
		// without stripping here, a monitor named "foo\nBcc: a@evil" could
		// inject SMTP headers via the body interpolation (Nodemailer's body
		// path generally protects, but this defense doesn't rely on the
		// library's internals).
		const safeName = sanitizeHeader(monitor.name);
		const safeIdent = sanitizeHeader(identifier ?? '');
		const subject = sanitizeHeader(isDown
			? t('notify.subjectDown', { name: safeName })
			: t('notify.subjectUp', { name: safeName }));
		const body = isDown
			? t('notify.emailDown', { name: safeName, host: safeIdent, status: newStatus, checks: failedChecks.join(', '), time })
			: t('notify.emailUp', { name: safeName, host: safeIdent, time });

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

	// Only mark the dedupe slot AFTER at least one channel succeeds. The
	// previous code set the 24-h dedupe regardless of dispatch outcome —
	// a Telegram 5xx silently swallowed the alert, the operator never
	// saw it, AND the dedupe blocked retries until the next day.
	let anySucceeded = false;

	if (settings.telegram.enabled && settings.telegram.botToken && settings.telegram.chatId) {
		const text = [
			`${emoji} <b>${escapeHtml(monitor.name)}</b> — ${t('notify.expiryTitle', { label })}`,
			`${t('notify.host')}: <code>${escapeHtml(monitor.domain)}</code>`,
			`\u{1F4C5} ${t('notify.expiresInDays', { days: daysRemaining })}`,
			`\u{1F552} ${formatLocalTime()}`
		].join('\n');
		try {
			await sendTelegramMessage(settings.telegram.botToken, settings.telegram.chatId, text);
			clearNotifyError('telegram');
			anySucceeded = true;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error('Telegram expiry notification failed:', msg);
			persistNotifyError('telegram', msg);
		}
	}

	if (settings.emailAlerts && settings.alertEmail) {
		try {
			await sendEmail({
				to: settings.alertEmail,
				subject: sanitizeHeader(t('notify.subjectExpiry', { label, name: monitor.name })),
				body: t('notify.emailExpiry', { label, name: monitor.name, host: monitor.domain, days: daysRemaining })
			});
			clearNotifyError('email');
			anySucceeded = true;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error('Email expiry notification failed:', msg);
			persistNotifyError('email', msg);
		}
	}

	if (anySucceeded) {
		const now = Date.now();
		expiryNotifiedAt.set(dedupeKey, now);
		persistExpiryNotifiedAt(monitor.id, type, now);
	}
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

// Pinned via `pinnedHttpsRequest` so resolver poisoning of `api.telegram.org`
// can't redirect alert traffic to a private LAN host. Matches the SMTP / S3 /
// WebDAV / RDAP / HTTP / SSL / ping invariant. Body capped to 4 KiB on errors
// so a hostile/MITM server can't OOM the agent process with a megabyte error
// payload (`.slice(0,200)` only ran after the full buffer was read).
const TELEGRAM_ERROR_BODY_CAP = 4 * 1024;
const TELEGRAM_GETME_BODY_CAP = 4 * 1024;

export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
	if (!TELEGRAM_BOT_TOKEN_RE.test(botToken)) throw new Error('Invalid Telegram bot token shape');
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
	const body = Buffer.from(JSON.stringify({
		chat_id: chatId,
		text: capTelegramText(text),
		parse_mode: 'HTML',
		disable_web_page_preview: true
	}), 'utf-8');
	const res = await pinnedHttpsRequest({
		method: 'POST',
		url,
		headers: { 'Content-Type': 'application/json' },
		body,
		timeoutMs: 10_000,
		maxBodyBytes: TELEGRAM_ERROR_BODY_CAP
	});
	if (res.status < 200 || res.status >= 300) {
		const msg = res.body.toString('utf-8').slice(0, 200);
		throw new Error(`Telegram API error ${res.status}: ${msg}`);
	}
}

export async function testTelegram(botToken: string, chatId: string): Promise<{ success: boolean; botName?: string; error?: string }> {
	if (!TELEGRAM_BOT_TOKEN_RE.test(botToken)) {
		return { success: false, error: 'Invalid bot token shape' };
	}
	try {
		const meRes = await pinnedHttpsRequest({
			method: 'GET',
			url: `https://api.telegram.org/bot${botToken}/getMe`,
			timeoutMs: 10_000,
			maxBodyBytes: TELEGRAM_GETME_BODY_CAP
		});
		if (meRes.status < 200 || meRes.status >= 300) return { success: false, error: 'Invalid bot token' };
		let parsed: { result?: { first_name?: string } } = {};
		try { parsed = JSON.parse(meRes.body.toString('utf-8')) as typeof parsed; } catch { /* leave empty */ }

		const t = getT();
		await sendTelegramMessage(botToken, chatId, `\u{2705} ${t('notify.telegramConnected')}`);
		return { success: true, botName: parsed.result?.first_name };
	} catch (e) {
		return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
	}
}
