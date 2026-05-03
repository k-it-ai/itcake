import nodemailer from 'nodemailer';
import sanitizeHtml from 'sanitize-html';
import crypto from 'node:crypto';
import { getSetting } from '$lib/server/db.js';
import { sanitizeSmtpError, sanitizeHeader } from '$lib/server/sanitize.js';
import { resolveAndValidate } from '$lib/server/checks/validate-target.js';
import { ServiceError } from '$lib/server/service-error.js';
import type { EmailSettings, EmailConfig } from '$lib/types.js';

function sanitizeEmailHtml(html: string): string {
	return sanitizeHtml(html, {
		allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'br', 'hr']),
		allowedAttributes: {
			...sanitizeHtml.defaults.allowedAttributes,
			img: ['src', 'alt', 'width', 'height', 'style'],
			a: ['href', 'name', 'target', 'rel'],
			'*': ['style', 'class']
		},
		allowedStyles: {
			'*': {
				'text-align': [/^(left|right|center|justify)$/],
				'text-decoration': [/^(underline|line-through|none)$/],
				'font-weight': [/^(bold|normal|\d{3})$/],
				'font-style': [/^(italic|normal)$/],
				'color': [/^#[0-9a-fA-F]{3,6}$/],
				'font-size': [/^\d+(\.\d+)?(px|pt|em|rem)$/],
				'margin': [/^\d+(\.\d+)?(px|em|rem|%)(\s+\d+(\.\d+)?(px|em|rem|%)){0,3}$/],
				'padding': [/^\d+(\.\d+)?(px|em|rem|%)(\s+\d+(\.\d+)?(px|em|rem|%)){0,3}$/],
				'width': [/^\d+(\.\d+)?(px|%|em)$/],
				'max-width': [/^\d+(\.\d+)?(px|%|em)$/]
			}
		},
		allowedSchemes: ['http', 'https', 'mailto'],
		allowedSchemesByTag: {
			img: ['data', 'cid']
		},
		transformTags: {
			'a': (tagName, attribs) => {
				if (attribs.target) attribs.rel = 'noopener noreferrer';
				return { tagName, attribs };
			}
		}
	});
}

function wrapHtmlEmail(body: string): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5;color:#333;max-width:600px;margin:0 auto;padding:20px">${body}</body></html>`;
}

let cachedTransport: nodemailer.Transporter | null = null;
let cachedConfigKey = '';

function configKey(config: EmailConfig): string {
	const passHash = crypto.createHash('sha256').update(config.pass ?? '').digest('hex').slice(0, 16);
	return `${config.host}:${config.port}:${config.secure}:${config.user}:${passHash}`;
}

function pinnedLookup(hostname: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void {
	resolveAndValidate(hostname)
		.then((ip) => cb(null, ip, ip.includes(':') ? 6 : 4))
		.catch((err: Error) => {
			const e = err as NodeJS.ErrnoException;
			e.code ||= 'EBLOCKED';
			cb(e, '', 0);
		});
}

function getTransport(config: EmailConfig): nodemailer.Transporter {
	const key = configKey(config);
	if (cachedTransport && cachedConfigKey === key) {
		return cachedTransport;
	}
	if (cachedTransport) {
		cachedTransport.close();
	}
	cachedTransport = nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.secure,
		auth: {
			user: config.user,
			pass: config.pass
		},
		pool: true,
		maxConnections: 3,
		requireTLS: !config.secure,
		tls: {
			minVersion: 'TLSv1.2',
			rejectUnauthorized: true,
			servername: config.host
		},
		lookup: pinnedLookup
	});
	cachedConfigKey = key;
	return cachedTransport;
}

interface SmtpSettings {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	pass: string;
}

interface SendEmailOptions {
	to: string;
	cc?: string;
	bcc?: string;
	subject: string;
	body: string;
	attachmentBuffer?: Buffer;
	attachmentName?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
	const emailSettings = getSetting<EmailSettings>('emails');
	const smtp = emailSettings.smtp;

	if (!smtp.host) {
		throw new ServiceError('error.smtpNotConfigured');
	}
	if (!smtp.from) {
		throw new ServiceError('error.smtpFromNotConfigured');
	}

	const transport = getTransport(smtp);


	// CRLF / RFC 822 quoting bugs through.
	const cleanFromName = (smtp.fromName || '').replace(/[\r\n\0\t]/g, ' ').trim();
	const mailOptions: nodemailer.SendMailOptions = {
		from: { name: cleanFromName, address: sanitizeHeader(smtp.from) },
		to: sanitizeHeader(options.to),
		subject: sanitizeHeader(options.subject),
		html: wrapHtmlEmail(sanitizeEmailHtml(options.body))
	};

	const splitAddresses = (s: string): string[] =>
		s.split(',').map(a => a.trim()).filter(a => a.length > 0);
	if (options.cc) {
		const list = splitAddresses(options.cc);
		if (list.length > 10) throw new ServiceError('error.tooManyRecipients');
		mailOptions.cc = list.map(sanitizeHeader);
	}
	if (options.bcc) {
		const list = splitAddresses(options.bcc);
		if (list.length > 10) throw new ServiceError('error.tooManyRecipients');
		mailOptions.bcc = list.map(sanitizeHeader);
	}

	if (options.attachmentBuffer && options.attachmentName) {
		mailOptions.attachments = [
			{
				filename: options.attachmentName,
				content: options.attachmentBuffer,
				contentType: 'application/pdf'
			}
		];
	}

	try {
		await transport.sendMail(mailOptions);
	} catch (err) {
		if (cachedTransport === transport) {
			cachedTransport = null;
			cachedConfigKey = '';
		}
		throw err;
	}
}

export async function testSmtpConnection(smtpSettings: SmtpSettings): Promise<{ success: boolean; error?: string }> {
	if (!smtpSettings.host) return { success: false, error: 'SMTP host is required' };

	const transport = nodemailer.createTransport({
		host: smtpSettings.host,
		port: smtpSettings.port,
		secure: smtpSettings.secure,
		auth: {
			user: smtpSettings.user,
			pass: smtpSettings.pass
		},
		requireTLS: !smtpSettings.secure,
		tls: {
			minVersion: 'TLSv1.2',
			rejectUnauthorized: true,
			servername: smtpSettings.host
		},
		lookup: pinnedLookup
	});

	try {
		await transport.verify();
		return { success: true };
	} catch (err) {
		return { success: false, error: sanitizeSmtpError(err) };
	} finally {
		transport.close();
	}
}

