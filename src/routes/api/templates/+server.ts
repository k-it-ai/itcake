import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { getTemplates, createTemplate, updateTemplate, removeTemplate } from '$services/templates.js';
import { validateTemplateSafety } from '$lib/server/template-renderer.js';

const templateOptionSchema = z.object({
	key: z.string().max(100),
	label: z.string().max(200),
	type: z.enum(['color', 'select', 'boolean', 'text', 'font']),
	default: z.union([z.string().max(500), z.boolean()]),
	options: z.array(z.object({ label: z.string().max(200), value: z.string().max(200) })).optional()
}).strict();

function validateTemplateOptions(options: unknown): z.infer<typeof templateOptionSchema>[] {
	if (!Array.isArray(options)) return [];
	const parsed = z.array(templateOptionSchema).max(30).safeParse(options);
	if (!parsed.success) {
		throw error(400, `Invalid template options: ${parsed.error.issues[0].message}`);
	}
	return parsed.data;
}

/** Validate HTML safety and CSS injection vectors for custom templates */
function validateTemplateContent(html: string | undefined, css: string | undefined, templateId: string): void {
	if (typeof html === 'string') {
		try { validateTemplateSafety(html, templateId); }
		catch { throw error(400, 'Template HTML contains unsafe EJS tags. Only <%= %> output tags are allowed.'); }
	}
	if (typeof css === 'string') {
		if (/<\/style\s*>/i.test(css)) {
			throw error(400, 'Template CSS must not contain </style> tags.');
		}
		if (/url\s*\(/i.test(css)) {
			const urlMatches = css.match(/url\s*\(\s*['"]?([^'")]+)/gi) ?? [];
			for (const m of urlMatches) {
				const inner = m.replace(/url\s*\(\s*['"]?/i, '');
				if (!inner.startsWith('data:')) {
					throw error(400, 'Template CSS url() only supports data: URIs.');
				}
			}
		}
	}
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
	return json(getTemplates());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	const { action, ...data } = body as { action?: string; [key: string]: unknown };

	if (action && action !== 'update' && action !== 'delete') {
		throw error(400, 'Invalid action');
	}

	if (action === 'update') {
		const { id, name, html, css, options: rawOptions } = data as {
			id: string; name?: string; html?: string; css?: string; options?: unknown[];
			[key: string]: unknown;
		};
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		if (typeof name === 'string' && (name.length === 0 || name.length > 200)) throw error(400, 'Name must be 1-200 characters');
		if (typeof html === 'string' && html.length > 500_000) throw error(400, 'HTML too large (max 500KB)');
		if (typeof css === 'string' && css.length > 500_000) throw error(400, 'CSS too large (max 500KB)');
		validateTemplateContent(html, css, id);
		// Explicitly pick only allowed fields — prevents prototype pollution or builtIn bypass
		const updateData: Record<string, unknown> = {};
		if (typeof name === 'string') updateData.name = name;
		if (typeof html === 'string') updateData.html = html;
		if (typeof css === 'string') updateData.css = css;
		if (Array.isArray(rawOptions)) updateData.options = validateTemplateOptions(rawOptions) as never[];
		const updated = updateTemplate(id, updateData, locals.user.id);
		if (!updated) throw error(404, 'Template not found or is built-in');
		return json(updated);
	}

	if (action === 'delete') {
		const { id } = data as { id: string };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		const result = removeTemplate(id, locals.user.id);
		if (!result.deleted) throw error(result.error?.includes('used by') ? 409 : 404, result.error || 'Template not found');
		return json({ ok: true });
	}

	// Create
	const { name, html, css, options } = data as {
		name: string;
		html: string;
		css: string;
		options: unknown[];
	};
	if (!name || typeof name !== 'string' || name.length > 200) throw error(400, 'Invalid name');
	if (!html || typeof html !== 'string' || html.length > 500_000) throw error(400, 'Invalid or oversized html (max 500KB)');
	if (css !== undefined && (typeof css !== 'string' || css.length > 500_000)) throw error(400, 'Invalid or oversized css (max 500KB)');
	validateTemplateContent(html, css, 'new');
	const template = createTemplate({
		name: name.trim(),
		html: html || '',
		css: (css as string) || '',
		options: validateTemplateOptions(options) as never[]
	}, locals.user.id);
	return json(template, { status: 201 });
};
