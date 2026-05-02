import type { RequestHandler } from './$types.js';
import { getTemplate } from '$services/templates.js';
import { buildTemplateContext } from '$lib/server/template-context.js';
import { renderTemplateHtml, sanitizeCss } from '$lib/server/template-renderer.js';
import { getSetting } from '$lib/server/db.js';
import type { Invoice, CompanySettings } from '$lib/types.js';
import ejs from 'ejs';
import fs from 'node:fs';
import path from 'node:path';
import { notFound, requireUser } from '$lib/server/request-utils.js';

const MASTER_TEMPLATE_DIR = path.resolve('assets/templates/_master');

/** Build a sample invoice for template preview. */
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
			{ id: '1', name: 'Web Development', description: 'Frontend & backend implementation', quantity: 40, unit: 'hours', unitPrice: 9500, taxRate: 21, items: [] },
			{ id: '2', name: 'Design Work', description: 'UI/UX design', quantity: 16, unit: 'hours', unitPrice: 8500, taxRate: 21, items: [] },
			{ id: '3', name: 'Hosting & Maintenance', description: 'Annual server hosting', quantity: 1, unit: '', unitPrice: 29900, taxRate: 21, items: [] }
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
			netTotal: 54_5900,
			discountCapped: false
		},
		sentAt: null,
		sentTo: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};
}

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);

	const template = getTemplate(params.id);
	if (!template) throw notFound();

	const sampleInvoice = buildSampleInvoice(params.id);
	const context = buildTemplateContext(sampleInvoice, 'invoice');
	const bodyHtml = renderTemplateHtml(template, context, 'preview');

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
			pagedJs: '',
			title: 'Template Preview'
		});
	} else {
		fullHtml = `<!DOCTYPE html><html><head><style>${sanitizeCss(template.css)}</style></head><body>${bodyHtml}</body></html>`;
	}

	// CSP is set by hooks.server.ts for all /api/*/preview endpoints — no need to duplicate here
	return new Response(fullHtml, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8'
		}
	});
};
