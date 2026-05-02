import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, requireId, requireUser } from '$lib/server/request-utils.js';
import { getTemplates, createTemplate, updateTemplate, removeTemplate } from '$services/templates.js';
import { validateTemplateSafety } from '$lib/server/template-renderer.js';

const templateOptionSchema = z.object({
	key: z.string().max(100).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'key must start with a letter and use only [a-zA-Z0-9_]'),
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

function validateTemplateContent(html: string | undefined, css: string | undefined, templateId: string): void {
	if (typeof html === 'string') {
		try { validateTemplateSafety(html, templateId); }
		catch (e) { throw error(400, e instanceof Error ? e.message : 'Template HTML contains unsafe content'); }
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
	requireUser(locals);
	return json(getTemplates());
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => {
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
			return json(createTemplate({
				name: name.trim(),
				html: html || '',
				css: (css as string) || '',
				options: validateTemplateOptions(options) as never[]
			}, userId), { status: 201 });
		},
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				const { name, html, css, options: rawOptions } = data as {
					name?: string; html?: string; css?: string; options?: unknown[];
				};
				if (typeof name === 'string' && (name.length === 0 || name.length > 200)) throw error(400, 'Name must be 1-200 characters');
				if (typeof html === 'string' && html.length > 500_000) throw error(400, 'HTML too large (max 500KB)');
				if (typeof css === 'string' && css.length > 500_000) throw error(400, 'CSS too large (max 500KB)');
				validateTemplateContent(html, css, id);
				const updateData: Record<string, unknown> = {};
				if (typeof name === 'string') updateData.name = name;
				if (typeof html === 'string') updateData.html = html;
				if (typeof css === 'string') updateData.css = css;
				if (Array.isArray(rawOptions)) updateData.options = validateTemplateOptions(rawOptions) as never[];
				const updated = updateTemplate(id, updateData, userId);
				if (!updated) throw notFound();
				return json(updated);
			},
			delete: (data, userId) => {
				const id = requireId(data);
				const result = removeTemplate(id, userId);
				if (!result.deleted) throw error(result.error?.includes('used by') ? 409 : 404, result.error || 'Template not found');
				return json({ ok: true });
			}
		}
	});
