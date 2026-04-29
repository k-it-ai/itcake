import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getTemplate } from '$services/templates.js';
import { notFound, requireUser } from '$lib/server/request-utils.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);

	const template = getTemplate(params.id);
	if (!template) throw notFound();

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
