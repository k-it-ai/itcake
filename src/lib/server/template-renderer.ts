import ejs from 'ejs';
import fs from 'node:fs';
import path from 'node:path';
import { getTemplate } from '#services/templates.js';
import { buildTemplateContext } from './template-context.js';
import type { Invoice, Proposal, Template } from '#lib/types.js';
import { escapeHtml } from './sanitize.js';

const MASTER_TEMPLATE_DIR = path.resolve('assets/templates/_master');

let masterTemplateCache: string | null = null;
let normalizeCssCache: string | null = null;

function getMasterTemplate(): string | null {
	if (masterTemplateCache === null) {
		const masterTemplatePath = path.join(MASTER_TEMPLATE_DIR, 'template.ejs');
		if (!fs.existsSync(masterTemplatePath)) return null;
		masterTemplateCache = fs.readFileSync(masterTemplatePath, 'utf-8');
	}
	return masterTemplateCache;
}

function getNormalizeCss(): string {
	if (normalizeCssCache === null) {
		const normalizePath = path.join(MASTER_TEMPLATE_DIR, 'normalize.css');
		normalizeCssCache = fs.existsSync(normalizePath) ? fs.readFileSync(normalizePath, 'utf-8') : '';
	}
	return normalizeCssCache;
}

// Root identifiers permitted inside <%= %> in custom templates.
const ALLOWED_EXPR_IDENTIFIERS = new Set([
	'document', 'type', 'isCreditNote', 'linkedInvoiceId', 'documentId',
	'seller', 'buyer', 'items', 'discounts', 'totals', 'currency', 'language',
	'pricingMode', 'templateOptions', 'issueDate', 'dueDate',
	'validUntil', 'paidDate', 'notes', 'footerText', 'introText',
	't', 'formatMoneyValue', 'formatMoney', 'formatDate', 'formatQuantity',
	'getSummaryItems', 'getTaxFields', 'getShortDocumentIdLabel',
	'getDocumentIdLabel', 'getDocumentDateLabel', 'escapeHtml', 'nl2br',
	'clsx', 'join', 'joinAddress', 'joinLegalInfo', 'isEuCountry',
	'getCountryName', 'optionsAsCssVariables', 'paymentQrCodeSvg',
	'paymentTermDays', 'computeItemSubtotal', 'kleinunternehmer',
	'kleinunternehmerNotice',
	'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'void',
	'name', 'email', 'phone', 'website', 'address', 'street', 'city', 'zip',
	'state', 'country', 'taxNumber', 'vatNumber', 'registrationNumber',
	'logoUrl', 'bankName', 'bankAccount', 'bankIban', 'bankSwift', 'legalInfo',
	'contactPerson',
	'id', 'description', 'quantity', 'unit', 'unitPrice', 'taxRate', 'value',
	'rate', 'taxableAmount', 'taxAmount', 'subtotal', 'discountAmount',
	'subtotalAfterDiscounts', 'taxSubtotals', 'totalTaxes', 'total', 'netTotal',
	'status', 'clientId', 'length', 'key', 'label', 'default', 'options',
	'item', 'sub', 'i', 'idx', 'index', 'row', 'col', 'field', 'entry', 'ts',
]);

export function validateTemplateSafety(html: string, templateId: string): void {
	// EJS does not respect HTML comments — strip-then-scan would let `<!-- <% RCE %> -->` slip through.
	const raw = html
		.replace(/\0/g, '')
		.replace(/[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/g, ' ')
		.normalize('NFC');

	if (/<%[ \t]*(?![=%#])/.test(raw) || /<%[ \t]*[-_](?!=)/.test(raw)) {
		throw new Error(`Template "${templateId}" contains unsafe EJS execution tags`);
	}

	const decommented = raw.replace(/<!--[\s\S]*?-->/g, '');

	if (/< *(script|iframe|object|embed|applet|base|link|meta\b[^>]*\bhttp-equiv|svg|form|video|audio|source|picture|math)\b/i.test(decommented)) {
		throw new Error(`Template "${templateId}" contains blocked HTML tags`);
	}
	if (/<[a-z](?:[^>'"]|'[^']*'|"[^"]*")*\bon[a-z]+\s*=/i.test(decommented)) {
		throw new Error(`Template "${templateId}" contains event handler attributes`);
	}

	const exprRegex = /<%=\s*([\s\S]*?)\s*[-_]?%>/g;
	let match;
	let exprCount = 0;
	while ((match = exprRegex.exec(raw)) !== null) {
		exprCount++;
		if (exprCount > 500) {
			throw new Error(`Template "${templateId}" has too many expressions (max 500)`);
		}
		const expr = match[1];
		if (expr.length > 200) {
			throw new Error(`Template "${templateId}" has an expression exceeding 200 characters`);
		}
		if (expr.includes('`')) {
			throw new Error(`Template "${templateId}" contains template literal: "${expr.slice(0, 60)}"`);
		}
		if (/\\u[0-9a-fA-F{]|\\x[0-9a-fA-F]/.test(expr)) {
			throw new Error(`Template "${templateId}" contains Unicode escape: "${expr.slice(0, 60)}"`);
		}
		const exprNoStrings = expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
		if (exprNoStrings.includes('[')) {
			throw new Error(`Template "${templateId}" contains bracket notation: "${expr.slice(0, 60)}"`);
		}
		const identifiers = exprNoStrings.match(/[a-zA-Z_$]\w*/g) ?? [];
		for (const ident of identifiers) {
			if (!ALLOWED_EXPR_IDENTIFIERS.has(ident)) {
				throw new Error(
					`Template "${templateId}" contains disallowed identifier "${ident}" in: "${expr.slice(0, 60)}"`
				);
			}
		}
	}
}

function deepFreeze(obj: unknown): unknown {
	if (obj === null || typeof obj !== 'object') return obj;
	Object.freeze(obj);
	for (const val of Object.values(obj as Record<string, unknown>)) {
		if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
			deepFreeze(val);
		}
	}
	return obj;
}

// Arrays keep prototype (EJS uses .forEach/.map). Functions copied by ref.
function toPrototypeFreeContext(src: Record<string, unknown>): Record<string, unknown> {
	const dst: Record<string, unknown> = Object.create(null);
	for (const [key, val] of Object.entries(src)) {
		if (val === null || val === undefined || typeof val !== 'object') {
			dst[key] = val;
		} else if (Array.isArray(val)) {
			dst[key] = val.map(item =>
				item !== null && typeof item === 'object' && !Array.isArray(item)
					? toPrototypeFreeContext(item as Record<string, unknown>)
					: item
			);
		} else if (typeof val === 'function') {
			dst[key] = val;
		} else {
			dst[key] = toPrototypeFreeContext(val as Record<string, unknown>);
		}
	}
	return dst;
}

export function renderTemplateHtml(
	template: Template,
	context: Record<string, unknown>,
	filenamePrefix = 'template'
): string {
	if (!template.builtIn) {
		validateTemplateSafety(template.html, template.id);
	}
	const renderContext = template.builtIn
		? context
		: deepFreeze(toPrototypeFreeContext(context)) as Record<string, unknown>;
	try {
		const safeId = template.id.replace(/[^a-zA-Z0-9_-]/g, '_');
		return ejs.render(template.html, renderContext, {
			filename: `${filenamePrefix}-${safeId}`,
			rmWhitespace: false,
			async: false
		});
	} catch (err) {
		throw new Error(`Template render error (${template.id}): ${err instanceof Error ? err.message : String(err)}`);
	}
}

export function renderDocument(
	doc: Invoice | Proposal,
	type: 'invoice' | 'proposal'
): string {
	const template = getTemplate(doc.templateId);
	if (!template) {
		throw new Error(`Template "${doc.templateId}" not found`);
	}

	const context = buildTemplateContext(doc, type);

	const bodyHtml = renderTemplateHtml(template, context);

	const masterTemplate = getMasterTemplate();
	if (!masterTemplate) {
		return wrapBasicHtml(bodyHtml, template.css, doc.documentId);
	}

	try {
		const fullHtml = ejs.render(masterTemplate, {
			...context,
			body: bodyHtml,
			templateCss: sanitizeCss(template.css),
			normalizeCss: getNormalizeCss(),
			title: `${type === 'invoice' ? (context.isCreditNote ? 'Credit Note' : 'Invoice') : 'Proposal'} ${doc.documentId}`
		}, { filename: 'master-template', async: false });

		return fullHtml;
	} catch (err) {
		throw new Error(`Master template render error (${doc.templateId}): ${err instanceof Error ? err.message : String(err)}`);
	}
}

// Closed allowlist — new CSS @-rules default to blocked.
const ALLOWED_AT_RULES = new Set(['page', 'media', 'supports', 'keyframes', '-webkit-keyframes', 'font-feature-values', 'layer']);

export function sanitizeCss(css: string): string {
	const noEscapes = css.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, ch) => {
		if (/^[0-9a-fA-F]+/.test(ch)) {
			const codePoint = parseInt(ch.trim(), 16);
			return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
		}
		return ch;
	});
	return noEscapes
		.replace(/<\/style\s*>/gi, '/* blocked */')
		.replace(/@\s*([\w-]+)/gi, (match, name: string) => {
			const lc = name.toLowerCase();
			return ALLOWED_AT_RULES.has(lc) ? match : '/* blocked */';
		})
		.replace(/url\s*\(\s*(['"]?)\s*(?!data:image\/(?:png|jpeg|gif|webp);)/gi, 'url($1blocked:')
		.replace(/expression\s*\(/gi, '/* blocked */(')
		.replace(/-moz-binding\s*:/gi, '/* blocked */:')
		.replace(/behavior\s*:/gi, '/* blocked */:');
}

function wrapBasicHtml(body: string, css: string, title: string): string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${sanitizeCss(css)}</style>
</head>
<body>${body}</body>
</html>`;
}
