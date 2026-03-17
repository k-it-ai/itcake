import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getTemplate } from '$services/templates.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401);

	const template = getTemplate(params.id);
	if (!template) throw error(404, 'Template not found');

	const exportData = {
		name: template.name,
		html: template.html,
		css: template.css,
		options: template.options
	};

	const json = JSON.stringify(exportData, null, 2);
	const safeName = template.name.replace(/[^a-zA-Z0-9_-]/g, '_');

	return new Response(json, {
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="template-${safeName}.json"`
		}
	});
};
