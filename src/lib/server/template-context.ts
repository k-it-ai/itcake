import dayjs from 'dayjs';
import fs from 'node:fs';
import path from 'node:path';
import { formatMoney, computeItemSubtotal } from '$lib/money.js';
import { getCountryName, isEuCountry } from '$lib/countries.js';
import { getTemplateStrings } from './template-strings.js';
import { generateSepaQrCode } from './qr-code.js';
import { getSetting } from '$lib/server/db.js';
import { UPLOAD_DIR } from '$lib/server/data-dir.js';
import { escapeHtml, sanitizeRichText } from '$lib/server/sanitize.js';
import { verifyMagicBytes } from '$lib/server/file-validation.js';
import type { Invoice, Proposal, SellerInfo, TaxSubtotal, AdvancedSettings } from '$lib/types.js';

// 10 MiB cap — must match /api/logo/[filename].
const MAX_LOGO_BYTES = 10 * 1024 * 1024;

const ALLOWED_LOGO_DATA_URI_RE = /^data:image\/(png|jpeg|webp);base64,/i;

function logoToDataUri(logoUrl: string): string {
	if (!logoUrl) return logoUrl;
	if (logoUrl.startsWith('data:')) {
		return ALLOWED_LOGO_DATA_URI_RE.test(logoUrl) ? logoUrl : '';
	}
	const match = logoUrl.match(/\/api\/logo\/(.+)$/);
	if (!match) return logoUrl;
	const filename = path.basename(match[1]);
	if (!filename) return '';
	const filePath = path.resolve(UPLOAD_DIR, filename);
	if (!filePath.startsWith(UPLOAD_DIR + path.sep)) return '';
	try {
		const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		let buffer: Buffer;
		try {
			const stat = fs.fstatSync(fd);
			if (stat.size > MAX_LOGO_BYTES) return '';
			buffer = Buffer.alloc(stat.size);
			let total = 0;
			while (total < stat.size) {
				const n = fs.readSync(fd, buffer, total, stat.size - total, total);
				if (n <= 0) break;
				total += n;
			}
		} finally {
			try { fs.closeSync(fd); } catch { /* best effort */ }
		}
		const ext = path.extname(filename).toLowerCase();
		const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
		const mime = mimeMap[ext] || 'image/png';
		if (!verifyMagicBytes(buffer, mime)) return '';
		return `data:${mime};base64,${buffer.toString('base64')}`;
	} catch (e) {
		console.warn(`Failed to read logo file ${filePath}:`, e instanceof Error ? e.message : e);
		return '';
	}
}

type Document = Invoice | Proposal;

export function buildTemplateContext(doc: Document, type: 'invoice' | 'proposal') {
	const strings = getTemplateStrings(doc.language);

	function t(key: string, replacements?: Record<string, string>): string {
		let str = strings[key] ?? key;
		if (replacements) {
			for (const [k, v] of Object.entries(replacements)) {
				str = str.replace(`{${k}}`, v);
			}
		}
		return str;
	}

	function formatMoneyValue(cents: number): string {
		return formatMoney(cents, doc.currency, doc.language);
	}

	let defaultDateFormat = 'DD/MM/YYYY';
	try {
		const general = getSetting('general') as { dateFormat?: string } | null;
		if (general?.dateFormat) defaultDateFormat = general.dateFormat;
	} catch (e) {
		console.warn('Failed to read general settings for date format, using default:', e instanceof Error ? e.message : e);
	}

	function formatDate(dateStr: string, format?: string): string {
		return dayjs(dateStr).format(format || defaultDateFormat);
	}

	function formatQuantity(qty: number): string {
		if (Number.isInteger(qty)) return String(qty);
		return qty.toLocaleString(doc.language, { maximumFractionDigits: 4 });
	}

	function getSummaryItems(): { description: string; amount: string }[] {
		return doc.items.map((item) => ({
			description: item.name || item.description,
			amount: formatMoneyValue(computeItemSubtotal(item))
		}));
	}

	function getTaxFields(): { label: string; amount: string }[] {
		return doc.totals.taxSubtotals.map((ts: TaxSubtotal) => ({
			label: `${t('tax')} ${ts.rate}%`,
			amount: formatMoneyValue(ts.taxAmount)
		}));
	}

	const isCreditNote = type === 'invoice' && (doc as Invoice).invoiceType === 'creditNote';

	function getShortDocumentIdLabel(): string {
		if (type === 'proposal') return t('proposalShort');
		return isCreditNote ? t('creditNoteShort') : t('invoiceShort');
	}

	function getDocumentIdLabel(): string {
		if (type === 'proposal') return t('proposalNumber');
		return isCreditNote ? t('creditNoteNumber') : t('invoiceNumber');
	}

	function getDocumentDateLabel(): string {
		if (type === 'proposal') return t('proposalDate');
		return isCreditNote ? t('creditNoteDate') : t('invoiceDate');
	}

	function nl2br(s: string): string {
		if (/<[a-z][a-z0-9]*[\s>\/]/i.test(s)) {
			return sanitizeRichText(s);
		}
		return escapeHtml(s).replace(/\n/g, '<br>');
	}

	function clsx(...classes: (string | false | null | undefined)[]): string {
		return classes.filter(Boolean).join(' ');
	}

	function join(...parts: (string | undefined | null)[]): string {
		return parts.filter(Boolean).join(', ');
	}

	function joinAddress(address: { street?: string; city?: string; zip?: string; state?: string; country?: string }, lang = 'en'): string {
		const parts = [
			address.street,
			[address.zip, address.city].filter(Boolean).join(' '),
			address.state,
			address.country ? getCountryName(address.country, lang) : undefined
		];
		return parts.filter(Boolean).join('\n');
	}

	function joinLegalInfo(seller: SellerInfo): string {
		const parts = [
			seller.taxNumber ? `${t('taxNumber')}: ${seller.taxNumber}` : null,
			seller.vatNumber ? `${t('vatNumber')}: ${seller.vatNumber}` : null,
			seller.registrationNumber ? `${t('registrationNumber')}: ${seller.registrationNumber}` : null,
			seller.legalInfo || null
		];
		return parts.filter(Boolean).join(' | ');
	}

	function optionsAsCssVariables(options: Record<string, unknown>): string {
		return Object.entries(options)
			.filter(([, v]) => typeof v === 'string' && v.length > 0)
			.map(([k, v]) => {
				const safeKey = k.replace(/[^a-zA-Z0-9-]/g, '');
				if (!safeKey) return null;
				const raw = (v as string).slice(0, 200);
				if (/^#[0-9a-fA-F]{3,8}$/.test(raw) || /^[a-zA-Z][a-zA-Z0-9 ,-]*$/.test(raw) || /^-?\d+(\.\d+)?(px|em|rem|%|pt|vh|vw)?$/.test(raw)) {
					return `--${safeKey}: ${raw}`;
				}
				return null;
			})
			.filter(Boolean)
			.join('; ');
	}

	let paymentQrCodeSvg: string | undefined;
	if (type === 'invoice' && !isCreditNote) {
		try {
			let advanced: AdvancedSettings;
			try {
				advanced = getSetting<AdvancedSettings>('advanced');
			} catch {
				advanced = { sepaQrEnabled: false } as AdvancedSettings;
			}
			if (advanced?.sepaQrEnabled && doc.seller.bankIban) {
				const inv = doc as Invoice;
				if (inv.status !== 'paid' && (doc.currency === 'EUR' || doc.currency === 'CHF')) {
					const svg = generateSepaQrCode({
						name: doc.seller.name,
						iban: doc.seller.bankIban,
						bic: doc.seller.bankSwift || '',
						amount: doc.totals.total,
						currency: doc.currency,
						reference: doc.documentId
					});
					if (typeof svg === 'string' && svg.startsWith('data:image/svg')) {
						paymentQrCodeSvg = svg;
					}
				}
			}
		} catch (e) {
			console.warn(`SEPA QR code generation failed for ${doc.documentId}:`, e instanceof Error ? e.message : e);
		}
	}

	let paymentTermDays = 0;
	if (type === 'invoice') {
		const inv = doc as Invoice;
		paymentTermDays = Math.max(0, dayjs(inv.dueDate).diff(dayjs(inv.issueDate), 'day'));
	}

	const isKleinunternehmer = (doc as Invoice & Proposal).kleinunternehmer === true;
	const kleinunternehmerNotice = isKleinunternehmer ? t('kleinunternehmerNotice') : '';

	const companySettings = getSetting<import('$lib/types.js').CompanySettings>('company');
	const effectiveLogoUrl = doc.seller.logoUrl || companySettings.logoUrl || '';
	const sellerWithLogo = { ...doc.seller, logoUrl: logoToDataUri(effectiveLogoUrl) };

	return {
		document: doc,
		type,
		isCreditNote,
		linkedInvoiceId: type === 'invoice' ? (doc as Invoice).linkedInvoiceId : null,
		documentId: doc.documentId,
		seller: sellerWithLogo,
		buyer: doc.buyer,
		items: doc.items,
		discounts: doc.discounts,
		totals: doc.totals,
		currency: doc.currency,
		language: doc.language,
		pricingMode: doc.pricingMode,
		templateOptions: doc.templateOptions,

		issueDate: doc.issueDate,
		dueDate: type === 'invoice' ? (doc as Invoice).dueDate : undefined,
		validUntil: type === 'proposal' ? (doc as Proposal).validUntil : undefined,
		paidDate: type === 'invoice' ? (doc as Invoice).paidDate : undefined,

		notes: doc.notes,
		footerText: doc.footerText,
		introText: type === 'proposal' ? (doc as Proposal).introText : undefined,

		t,
		formatMoneyValue,
		formatMoney: formatMoneyValue,
		formatDate,
		formatQuantity,
		getSummaryItems,
		getTaxFields,
		getShortDocumentIdLabel,
		getDocumentIdLabel,
		getDocumentDateLabel,
		escapeHtml,
		nl2br,
		clsx,
		join,
		joinAddress,
		joinLegalInfo,
		isEuCountry,
		getCountryName,
		optionsAsCssVariables,
		paymentQrCodeSvg,
		paymentTermDays,
		computeItemSubtotal,
		kleinunternehmer: isKleinunternehmer,
		kleinunternehmerNotice
	};
}
