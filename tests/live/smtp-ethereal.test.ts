/**
 * Live SMTP test against Ethereal.
 *
 * Ethereal is a real SMTP service (STARTTLS + AUTH + DNS) that catches mail
 * instead of delivering it, so this test can exercise the production send path
 * without emailing a real person. It verifies:
 *   - the settings API rejects loopback/private SMTP targets (SSRF guard)
 *   - SMTP settings save and the real connection test succeeds
 *   - a message with CRLF header-injection attempts in the subject/from name
 *     is delivered with a single-line subject and no injected Bcc header
 *   - the HTML body is sanitized (script/event handlers/javascript: removed)
 *
 * The test creates a disposable Ethereal account. If the account API is
 * unreachable (offline run), the suite skips instead of failing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	startProductionServer, freshDataDir, cleanupDir, jsonCall, setupAdmin, sleep,
	type LiveServer
} from './helpers';
import { fetchImapMessages } from './imap';

const PORT = 5504;
const DATA_DIR = freshDataDir('smtp-ethereal');
const ADMIN_EMAIL = 'smtp-live@example.com';

interface EtherealAccount {
	user: string;
	pass: string;
	smtp: { host: string; port: number; secure: boolean };
	imap: { host: string; port: number; secure: boolean };
}

async function createEtherealAccount(): Promise<EtherealAccount | null> {
	try {
		const res = await fetch('https://api.nodemailer.com/user', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ requestor: 'itcake-live-test', version: '0.1.0' }),
			signal: AbortSignal.timeout(15_000)
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { status?: string } & EtherealAccount;
		return data.status === 'success' ? data : null;
	} catch {
		return null;
	}
}

const account = await createEtherealAccount();
const hasEthereal = account !== null;

let server: LiveServer;
let cookie = '';
let emailSettings: Record<string, unknown>;

function smtpConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		host: account!.smtp.host,
		port: account!.smtp.port,
		secure: account!.smtp.secure,
		user: account!.user,
		pass: account!.pass,
		from: account!.user,
		// Deliberate header-injection attempt: sendEmail must sanitize this.
		fromName: 'ITCake Live\r\nBcc: attacker@example.com',
		...overrides
	};
}

beforeAll(async () => {
	if (!hasEthereal) return;
	server = await startProductionServer({ port: PORT, dataDir: DATA_DIR });
	cookie = await setupAdmin(server, ADMIN_EMAIL);
	const settings = await jsonCall(server, 'GET', '/api/settings', undefined, { cookie });
	expect(settings.status).toBe(200);
	emailSettings = settings.data.emails as Record<string, unknown>;
	expect(emailSettings, 'emails settings section missing').toBeTruthy();
}, 120_000);

afterAll(async () => {
	await server?.stop();
	cleanupDir(DATA_DIR);
});

describe.skipIf(!hasEthereal)('live SMTP through Ethereal', () => {
	it('rejects a loopback SMTP host before saving', async () => {
		const res = await jsonCall(server, 'POST', '/api/settings', {
			section: 'emails',
			data: { ...emailSettings, smtp: smtpConfig({ host: '127.0.0.1', port: 2525 }) }
		}, { cookie });

		expect(res.status).toBe(400);
		expect(JSON.stringify(res.data)).toMatch(/blocked IP range/i);
	}, 30_000);

	it('saves real SMTP settings and passes the connection test', async () => {
		const save = await jsonCall(server, 'POST', '/api/settings', {
			section: 'emails',
			data: { ...emailSettings, smtp: smtpConfig() }
		}, { cookie });
		expect(save.status, JSON.stringify(save.data)).toBe(200);
		expect(save.data.ok).toBe(true);

		// This performs a real DNS lookup, TCP connect, STARTTLS handshake, and
		// AUTH against Ethereal — the same code path the settings UI uses.
		const test = await jsonCall(server, 'POST', '/api/emails', { action: 'test' }, { cookie });
		expect(test.status).toBe(200);
		expect(test.data, `SMTP connection test failed: ${JSON.stringify(test.data)}`).toMatchObject({ ok: true });
	}, 90_000);

	it('sends a real message and sanitizes headers and HTML', async () => {
		const marker = `ITCake live SMTP ${Date.now()}`;
		const subject = `${marker}\r\nBcc: attacker@example.com <script>`;
		const body =
			`<p>Hello ${marker}</p>` +
			`<script>alert('xss')</script>` +
			`<img src="x" onerror="alert('xss')">` +
			`<a href="javascript:alert('xss')">click</a>`;

		const send = await jsonCall(server, 'POST', '/api/emails', {
			to: account!.user,
			subject,
			body
		}, { cookie });
		expect(send.status, JSON.stringify(send.data)).toBe(200);
		expect(send.data.ok).toBe(true);

		// Ethereal stores the message in the sender's INBOX. Poll briefly: the
		// SMTP transaction completes before the message is indexed.
		let raw = '';
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const messages = await fetchImapMessages({
				...account!.imap,
				user: account!.user,
				pass: account!.pass
			});
			raw = messages.find((message) => message.includes(marker)) ?? '';
			if (raw) break;
			await sleep(1_000);
		}
		expect(raw, 'sent message never appeared in the Ethereal INBOX').toBeTruthy();

		const headerEnd = raw.indexOf('\r\n\r\n');
		expect(headerEnd, 'message has no header/body separator').toBeGreaterThan(0);
		const headers = raw.slice(0, headerEnd);
		const subjectLine = headers.split('\r\n').find((line) => /^Subject:/i.test(line)) ?? '';
		const fromLine = headers.split('\r\n').find((line) => /^From:/i.test(line)) ?? '';
		const toLine = headers.split('\r\n').find((line) => /^To:/i.test(line)) ?? '';

		// The injected CRLF must not create a Bcc header.
		expect(headers).not.toMatch(/^Bcc:/im);
		// Subject and From stay single-line, and angle brackets are stripped.
		expect(subjectLine).toContain(marker);
		expect(subjectLine).not.toMatch(/[<>]/);
		expect(subjectLine).toContain('Bcc: attacker@example.com');
		expect(fromLine).toContain('ITCake Live');
		expect(toLine).toContain(account!.user);

		// sanitize-html must remove script tags, event handlers, and
		// javascript: URLs, while keeping the legitimate body text.
		expect(raw).not.toContain('<script');
		expect(raw).not.toContain('onerror=');
		expect(raw).not.toContain('javascript:');
		expect(raw).toContain(`Hello ${marker}`);
		expect(raw).toContain('<!DOCTYPE html>');
	}, 120_000);
});
