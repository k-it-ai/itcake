import nodemailer from 'nodemailer';
import type { Transporter, SendMailOptions } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.d.ts';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.d.ts';
import sanitizeHtml from 'sanitize-html';
import crypto from 'node:crypto';
import { getSetting } from '#lib/server/db.js';
import { sanitizeSmtpError, sanitizeHeader, sanitizeSubjectText } from '#lib/server/sanitize.js';
import { resolveTarget } from '#lib/server/checks/validate-target.js';
import { ServiceError } from '#lib/server/service-error.js';
import type { EmailSettings, EmailConfig } from '#lib/types.js';

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
			},
			'img': (tagName, attribs) => {
				// Allow raster data URIs only; SVG-as-image has historically
				// executed script in some mail clients.
				if (attribs.src && /^data:image\/svg/i.test(attribs.src)) {
					delete attribs.src;
				}
				return { tagName, attribs };
			}
		}
	});
}

function wrapHtmlEmail(body: string): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5;color:#333;max-width:600px;margin:0 auto;padding:20px">${body}</body></html>`;
}

let cachedTransport: Transporter | null = null;
let cachedConfigKey = '';

function configKey(config: EmailConfig): string {
	const passHash = crypto.createHash('sha256').update(config.pass ?? '').digest('hex').slice(0, 16);
	return `${config.host}:${config.port}:${config.secure}:${config.user}:${passHash}`;
}

// nodemailer ignores the `lookup` option, so pre-resolve and pass an IP as `host`;
// `servername` keeps SNI on the hostname for cert verification.
async function getTransport(config: EmailConfig): Promise<Transporter> {
	const key = configKey(config);
	if (cachedTransport && cachedConfigKey === key) {
		return cachedTransport;
	}
	if (cachedTransport) {
		cachedTransport.close();
		cachedTransport = null;
		cachedConfigKey = '';
	}
	const pinnedIp = await resolveTarget(config.host);
	const poolOpts = {
		host: pinnedIp,
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
		}
	} as SMTPPool.Options;
	cachedTransport = nodemailer.createTransport(poolOpts);
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
	text?: string;
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

	const transport = await getTransport(smtp);


	const cleanFromName = sanitizeHeader(smtp.fromName || '');
	const mailOptions: SendMailOptions = {
		from: { name: cleanFromName, address: sanitizeHeader(smtp.from) },
		to: sanitizeHeader(options.to),
		subject: sanitizeSubjectText(options.subject),
		html: wrapHtmlEmail(sanitizeEmailHtml(options.body)),
		...(options.text ? { text: options.text } : {})
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
				filename: sanitizeHeader(options.attachmentName),
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

	let pinnedIp: string;
	try {
		pinnedIp = await resolveTarget(smtpSettings.host);
	} catch (err) {
		return { success: false, error: sanitizeSmtpError(err) };
	}
	const testOpts = {
		host: pinnedIp,
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
		}
	} as SMTPTransport.Options;
	const transport = nodemailer.createTransport(testOpts);

	try {
		await transport.verify();
		return { success: true };
	} catch (err) {
		return { success: false, error: sanitizeSmtpError(err) };
	} finally {
		transport.close();
	}
}

