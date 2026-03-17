import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getTemplate } from '$services/templates.js';
import { buildTemplateContext } from '$lib/server/template-context.js';
import { renderTemplateHtml, sanitizeCss } from '$lib/server/template-renderer.js';
import { generateThumbnail } from '$lib/server/pdf.js';
import { getSetting } from '$lib/server/db.js';
import type { Invoice, CompanySettings } from '$lib/types.js';
import { createHash } from 'node:crypto';
import ejs from 'ejs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MASTER_TEMPLATE_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../../../assets/templates/_master'
);

// Cache thumbnails in memory to avoid re-rendering on every request.
// Bounded to prevent unbounded memory growth (each PNG is ~50-150 KB).
const MAX_CACHE_SIZE = 50;
const thumbnailCache = new Map<string, { buffer: Buffer; updatedAt: string; masterMtime: number }>();

/** Get master template modification time for cache invalidation */
function getMasterMtime(): number {
	try {
		return fs.statSync(path.join(MASTER_TEMPLATE_DIR, 'template.ejs')).mtimeMs;
	} catch { return 0; }
}

/**
 * Build a sample invoice for template preview rendering.
 */
function buildSampleInvoice(templateId: string): Invoice {
	const company = getSetting<CompanySettings>('company');
	const now = new Date().toISOString().split('T')[0];
	return {
		id: 'preview',
		documentId: '2026-0001',
		invoiceType: 'invoice',
		linkedInvoiceId: null,
		clientId: '',
		status: 'draft',
		pricingMode: 'net',
		currency: 'EUR',
		language: 'en',
		issueDate: now,
		dueDate: now,
		paidDate: null,
		items: [
			{ id: '1', name: 'Web Development', description: '', quantity: 40, unit: 'hours', unitPrice: 9500, taxRate: 21, items: [] },
			{ id: '2', name: 'Design Work', description: '', quantity: 16, unit: 'hours', unitPrice: 8500, taxRate: 21, items: [] },
			{ id: '3', name: 'Hosting & Maintenance', description: '', quantity: 1, unit: '', unitPrice: 29900, taxRate: 21, items: [] }
		],
		discounts: [],
		notes: 'Payment within 30 days.',
		footerText: 'Thank you for your business!',
		templateId,
		templateOptions: {},
		recurring: null,
		seller: {
			name: company.name || 'Acme Corp',
			email: company.email || 'info@acme.com',
			phone: company.phone || '+1 555 0100',
			website: company.website || 'www.acme.com',
			taxNumber: company.taxNumber || '',
			vatNumber: company.vatNumber || 'DE123456789',
			registrationNumber: company.registrationNumber || '',
			address: company.address || { street: '123 Main St', city: 'Berlin', zip: '10115', state: '', country: 'DE' },
			logoUrl: company.logoUrl || '',
			bankName: company.bankName || 'Deutsche Bank',
			bankAccount: company.bankAccount || '',
			bankIban: company.bankIban || 'DE89 3704 0044 0532 0130 00',
			bankSwift: company.bankSwift || 'DEUTDEDB',
			legalInfo: company.legalInfo || ''
		},
		buyer: {
			name: 'Sample Client GmbH',
			email: 'client@example.com',
			phone: '+49 30 1234567',
			vatNumber: 'DE987654321',
			registrationNumber: '',
			contactPerson: '',
			address: { street: 'Alexanderplatz 1', city: 'Berlin', zip: '10178', state: '', country: 'DE' }
		},
		totals: {
			subtotal: 54_5900,
			discountAmount: 0,
			subtotalAfterDiscounts: 54_5900,
			taxSubtotals: [{ rate: 21, taxableAmount: 54_5900, taxAmount: 11_4639 }],
			totalTaxes: 11_4639,
			total: 66_0539,
			netTotal: 54_5900
		},
		sentAt: null,
		sentTo: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401);

	const template = getTemplate(params.id);
	if (!template) throw error(404, 'Template not found');

	// Cache key includes company settings so logo/name changes invalidate thumbnails
	const company = getSetting<CompanySettings>('company');
	const companyHash = createHash('md5')
		.update(JSON.stringify([company.name, company.logoUrl, company.address]))
		.digest('hex').slice(0, 8);
	const cacheKey = `${params.id}:${companyHash}`;

	// Check cache (invalidate if master template changed on disk)
	const masterMtime = getMasterMtime();
	const cached = thumbnailCache.get(cacheKey);
	if (cached && cached.updatedAt === template.updatedAt && cached.masterMtime === masterMtime) {
		return new Response(new Uint8Array(cached.buffer), {
			headers: {
				'Content-Type': 'image/png',
				'Cache-Control': 'private, max-age=3600'
			}
		});
	}

	// Render sample invoice with this template (sandbox-safe for custom templates)
	const sampleInvoice = buildSampleInvoice(params.id);
	const context = buildTemplateContext(sampleInvoice, 'invoice');
	const bodyHtml = renderTemplateHtml(template, context, 'thumbnail');

	// Wrap in master template
	let fullHtml: string;
	const masterTemplatePath = path.join(MASTER_TEMPLATE_DIR, 'template.ejs');
	if (fs.existsSync(masterTemplatePath)) {
		const masterTemplate = fs.readFileSync(masterTemplatePath, 'utf-8');
		let normalizeCss = '';
		const normalizePath = path.join(MASTER_TEMPLATE_DIR, 'normalize.css');
		if (fs.existsSync(normalizePath)) normalizeCss = fs.readFileSync(normalizePath, 'utf-8');

		fullHtml = ejs.render(masterTemplate, {
			...context,
			body: bodyHtml,
			templateCss: sanitizeCss(template.css),
			normalizeCss,
			pagedJs: '', // skip paged.js for thumbnail
			title: 'Template Preview'
		});
	} else {
		fullHtml = `<!DOCTYPE html><html><head><style>${sanitizeCss(template.css)}</style></head><body>${bodyHtml}</body></html>`;
	}

	let thumbnail: Buffer;
	try {
		thumbnail = await generateThumbnail(fullHtml);
	} catch (e) {
		console.error(`Thumbnail generation failed for template ${params.id}:`, e);
		throw error(500, 'Thumbnail generation failed');
	}

	// Cache it (evict oldest entry if at capacity)
	if (thumbnailCache.size >= MAX_CACHE_SIZE) {
		const oldest = thumbnailCache.keys().next().value!;
		thumbnailCache.delete(oldest);
	}
	thumbnailCache.set(cacheKey, { buffer: thumbnail, updatedAt: template.updatedAt, masterMtime });

	return new Response(new Uint8Array(thumbnail), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'private, max-age=3600'
		}
	});
};
