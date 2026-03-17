import ejs from 'ejs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTemplate } from '$services/templates.js';
import { buildTemplateContext } from './template-context.js';
import type { Invoice, Proposal, Template } from '$lib/types.js';
import { escapeHtml } from './sanitize.js';

const MASTER_TEMPLATE_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../assets/templates/_master'
);

// Cached master template + assets to avoid repeated disk reads
let masterTemplateCache: string | null = null;
let normalizeCssCache: string | null = null;
let pagedJsCache: string | null = null;

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

function getPagedJs(): string {
	if (pagedJsCache === null) {
		const pagedPath = path.join(MASTER_TEMPLATE_DIR, 'paged.polyfill.js');
		pagedJsCache = fs.existsSync(pagedPath) ? fs.readFileSync(pagedPath, 'utf-8') : '';
	}
	return pagedJsCache;
}

/**
 * Allowlist of root identifiers permitted inside <%= %> expressions.
 * These match the keys exported by buildTemplateContext() plus basic JS keywords.
 *
 * ALLOWLIST vs BLOCKLIST: A blocklist must enumerate every dangerous identifier
 * (constructor, __proto__, process, etc.) and will always miss novel bypass vectors.
 * An allowlist only permits known-safe names — any new JS global or prototype gadget
 * is automatically blocked because it's not on the list.
 */
const ALLOWED_EXPR_IDENTIFIERS = new Set([
	// Template context data
	'document', 'type', 'isCreditNote', 'linkedInvoiceId', 'documentId',
	'seller', 'buyer', 'items', 'discounts', 'totals', 'currency', 'language',
	'pricingMode', 'templateOptions', 'issueDate', 'dueDate',
	'validUntil', 'paidDate', 'notes', 'footerText', 'introText',
	// Template context helper functions
	't', 'formatMoneyValue', 'formatMoney', 'formatDate', 'formatQuantity',
	'getSummaryItems', 'getTaxFields', 'getShortDocumentIdLabel',
	'getDocumentIdLabel', 'getDocumentDateLabel', 'escapeHtml', 'nl2br',
	'clsx', 'join', 'joinAddress', 'joinLegalInfo', 'isEuCountry',
	'getCountryName', 'optionsAsCssVariables', 'paymentQrCodeSvg',
	'paymentTermDays', 'computeItemSubtotal', 'kleinunternehmer',
	'kleinunternehmerNotice',
	// JS keywords and literals that appear in expressions
	'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'void',
	// Property names accessed via dot notation (e.g. seller.name, totals.total)
	'name', 'email', 'phone', 'website', 'address', 'street', 'city', 'zip',
	'state', 'country', 'taxNumber', 'vatNumber', 'registrationNumber',
	'logoUrl', 'bankName', 'bankAccount', 'bankIban', 'bankSwift', 'legalInfo',
	'contactPerson',
	'id', 'description', 'quantity', 'unit', 'unitPrice', 'taxRate', 'value',
	'rate', 'taxableAmount', 'taxAmount', 'subtotal', 'discountAmount',
	'subtotalAfterDiscounts', 'taxSubtotals', 'totalTaxes', 'total', 'netTotal',
	'status', 'clientId', 'length', 'key', 'label', 'default', 'options',
	// Common loop variables in template expressions
	'item', 'sub', 'i', 'idx', 'index', 'row', 'col', 'field', 'entry', 'ts',
]);

/**
 * Validate that a custom template contains no unsafe EJS execution tags.
 * Only <%= %> (HTML-escaped output) and <%# %> (comments) are allowed.
 * <% %> and <%- %> allow arbitrary code execution (RCE/XSS).
 *
 * Additionally, expressions inside <%= %> are checked for dangerous
 * identifiers (constructor, __proto__, process, etc.) that would allow
 * prototype chain traversal to reach Function and execute arbitrary code.
 *
 * Pattern 1: /<%(?![=%#])/ — catches bare scriptlet tags <% code %> that aren't
 *   followed by = (escaped output), % (EJS comment delimiter), or # (comment)
 * Pattern 2: /<%[-_](?!=)/ — catches <%- (unescaped output, allows HTML injection)
 *   and <%_ (whitespace-slurp scriptlet) unless followed by = (which isn't valid EJS)
 */
export function validateTemplateSafety(html: string, templateId: string): void {
	// Strip null bytes, HTML comments, and normalize Unicode whitespace to ASCII
	const decommented = html
		.replace(/\0/g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/g, ' ');
	if (/<%[ \t]*(?![=%#])/.test(decommented) || /<%[ \t]*[-_](?!=)/.test(decommented)) {
		throw new Error(`Template "${templateId}" contains unsafe EJS execution tags`);
	}

	// Block HTML tags that execute code or load external resources.
	// CSP headers protect browser preview, but Puppeteer's page.setContent() bypasses
	// HTTP headers entirely — these tags would execute unconstrained in Chromium.
	// NOTE: No /g flag — RegExp.test() with /g has statefulness via lastIndex that
	// causes every-other-call to skip matching (a well-known JS footgun).
	if (/< *(script|iframe|object|embed|applet|base|link|meta\b[^>]*\bhttp-equiv|svg)\b/i.test(decommented)) {
		throw new Error(`Template "${templateId}" contains blocked HTML tags (script, iframe, object, embed, applet, base, link[rel], meta[http-equiv], svg)`);
	}
	// Block event handler attributes on any tag (onload, onerror, onclick, etc.)
	if (/<[a-z][^>]*\bon[a-z]+\s*=/i.test(decommented)) {
		throw new Error(`Template "${templateId}" contains event handler attributes`);
	}

	// Extract all <%= ... %> expressions and validate via allowlist.
	// Every identifier in the expression must be on the allowlist — any unknown
	// identifier (constructor, __proto__, process, require, etc.) is rejected.
	const exprRegex = /<%=\s*([\s\S]*?)\s*[-_]?%>/g;
	let match;
	let exprCount = 0;
	while ((match = exprRegex.exec(decommented)) !== null) {
		exprCount++;
		if (exprCount > 500) {
			throw new Error(`Template "${templateId}" has too many expressions (max 500)`);
		}
		const expr = match[1];
		if (expr.length > 200) {
			throw new Error(`Template "${templateId}" has an expression exceeding 200 characters`);
		}
		// Block backticks (tagged template literals bypass identifier checks)
		if (expr.includes('`')) {
			throw new Error(`Template "${templateId}" contains template literal: "${expr.slice(0, 60)}"`);
		}
		// Block Unicode/hex escapes (\u0063onstructor === constructor)
		if (/\\u[0-9a-fA-F{]|\\x[0-9a-fA-F]/.test(expr)) {
			throw new Error(`Template "${templateId}" contains Unicode escape: "${expr.slice(0, 60)}"`);
		}
		// Strip string literals before extracting identifiers — translation keys like
		// t('constructor') should not trigger the allowlist check for 'constructor'.
		const exprNoStrings = expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
		// Block bracket notation on the string-stripped version so that brackets
		// inside string literals (e.g. t('[label]')) don't cause false positives,
		// while real bracket access (obj[key]) is still caught.
		if (exprNoStrings.includes('[')) {
			throw new Error(`Template "${templateId}" contains bracket notation: "${expr.slice(0, 60)}"`);
		}
		// Extract all identifier-like tokens and verify each is on the allowlist.
		// Identifiers: sequences of word chars that start with a letter or underscore.
		// This skips numbers (123), operators (+, -, >, etc.), strings ('text'), and punctuation.
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

/**
 * Safely render a template's EJS HTML with context.
 * Applies sandbox validation for custom (non-built-in) templates.
 */
export function renderTemplateHtml(
	template: Template,
	context: Record<string, unknown>,
	filenamePrefix = 'template'
): string {
	if (!template.builtIn) {
		validateTemplateSafety(template.html, template.id);
	}
	try {
		const safeId = template.id.replace(/[^a-zA-Z0-9_-]/g, '_');
		return ejs.render(template.html, context, {
			filename: `${filenamePrefix}-${safeId}`,
			rmWhitespace: false,
			async: false // Explicit: prevent async code injection in templates
		});
	} catch (err) {
		throw new Error(`Template render error (${template.id}): ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Render an invoice or proposal to HTML using its EJS template.
 *
 * Pipeline:
 * 1. Load the document's template (EJS + CSS)
 * 2. Build the template context with all helper functions
 * 3. Render the template EJS with the context
 * 4. Wrap in the master template (adds normalize.css, paged.js, etc.)
 * 5. Return complete HTML string
 */
export function renderDocument(
	doc: Invoice | Proposal,
	type: 'invoice' | 'proposal'
): string {
	const template = getTemplate(doc.templateId);
	if (!template) {
		throw new Error(`Template "${doc.templateId}" not found`);
	}

	// Build context with all helpers
	const context = buildTemplateContext(doc, type);

	// Render the template body (includes sandbox validation for custom templates)
	const bodyHtml = renderTemplateHtml(template, context);

	// Load master template (cached)
	const masterTemplate = getMasterTemplate();
	if (!masterTemplate) {
		// No master template — return body with inline CSS
		return wrapBasicHtml(bodyHtml, template.css, doc.documentId);
	}

	// Render master template wrapping the body
	try {
		const fullHtml = ejs.render(masterTemplate, {
			...context,
			body: bodyHtml,
			templateCss: sanitizeCss(template.css),
			normalizeCss: getNormalizeCss(),
			pagedJs: getPagedJs(),
			title: `${type === 'invoice' ? (context.isCreditNote ? 'Credit Note' : 'Invoice') : 'Proposal'} ${doc.documentId}`
		}, { filename: 'master-template' });

		return fullHtml;
	} catch (err) {
		throw new Error(`Master template render error (${doc.templateId}): ${err instanceof Error ? err.message : String(err)}`);
	}
}

export function sanitizeCss(css: string): string {
	// Strip CSS backslash escapes first — they can bypass scheme detection
	// (e.g. url(h\ttp://evil.com) resolves to url(http://evil.com) in CSS parsers)
	const noEscapes = css.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, ch) => {
		// Resolve hex escapes to their character; drop everything else
		if (/^[0-9a-fA-F]+/.test(ch)) {
			const codePoint = parseInt(ch.trim(), 16);
			return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
		}
		return ch;
	});
	return noEscapes
		.replace(/<\/style\s*>/gi, '/* blocked */')
		.replace(/@import\b[^;]*;?/gi, '/* blocked */')
		.replace(/@charset\b[^;]*;?/gi, '/* blocked */')
		.replace(/@\s*font-face\b/gi, '/* blocked */')
		.replace(/@\s*namespace\b/gi, '/* blocked */')
		.replace(/@\s*document\b/gi, '/* blocked */')
		// Block ALL url() except data: URIs — prevents SSRF, XSS, and resource exfiltration.
		// This is stricter than scheme-specific blocking and catches relative URLs, blob:, etc.
		.replace(/url\s*\(\s*(['"]?)\s*(?!data:)/gi, 'url($1blocked:')
		// Legacy browser CSS-based XSS vectors
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
