import {
	db,
	generateId,
	getDocument,
	getDocumentsByType,
	insertDocument,
	updateDocument,
	deleteDocument
} from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
import type { Template } from '$lib/types.js';
import fs from 'node:fs';
import path from 'node:path';
const BUILT_IN_TEMPLATES_DIR = path.resolve('assets/templates');

// Built-in template IDs
export const BUILT_IN_TEMPLATES = [
	'itcake'
];

/**
 * Default template ID used when an invoice or proposal has no explicit
 * `templateId` and the operator hasn't configured a default in Settings.
 * Must always be a member of BUILT_IN_TEMPLATES — otherwise PDF / preview
 * rendering throws `Template "<id>" not found` on a fresh install.
 */
export const DEFAULT_TEMPLATE_ID = 'itcake';

// Cache built-in templates in memory — they don't change at runtime
const builtInCache = new Map<string, Template>();

/**
 * Get all templates (built-in + custom).
 */
export function getTemplates(): Template[] {
	const builtIn = BUILT_IN_TEMPLATES.map((id) => loadBuiltInTemplate(id)).filter(Boolean) as Template[];
	const custom = getDocumentsByType<Template>('template');
	return [...builtIn, ...custom];
}

/**
 * Get a single template by ID.
 * For built-in IDs, checks DB first for a user override, then falls back to disk.
 */
export function getTemplate(id: string): Template | null {
	if (BUILT_IN_TEMPLATES.includes(id)) {
		// Check for user override in DB first
		const override = getDocument<Template>(id, 'template');
		if (override) {
			override.builtIn = false; // DB templates are never trusted as built-in
			return override;
		}
		return loadBuiltInTemplate(id);
	}
	const template = getDocument<Template>(id, 'template');
	// Defense-in-depth: DB-stored templates must never have builtIn: true.
	// builtIn bypasses EJS sandbox validation — only disk-loaded templates are trusted.
	if (template && template.builtIn) {
		template.builtIn = false;
	}
	return template;
}

/**
 * Load a built-in template from the assets directory.
 * Caches on first access — built-in templates don't change at runtime.
 */
function loadBuiltInTemplate(id: string): Template | null {
	const cached = builtInCache.get(id);
	if (cached) return cached;

	const templateDir = path.join(BUILT_IN_TEMPLATES_DIR, id);
	const templateFile = path.join(templateDir, 'template.ejs');

	if (!fs.existsSync(templateFile)) return null;

	const html = fs.readFileSync(templateFile, 'utf-8');

	// Try to load CSS
	let css = '';
	const cssFile = path.join(templateDir, 'style.css');
	if (fs.existsSync(cssFile)) {
		css = fs.readFileSync(cssFile, 'utf-8');
	}

	// Try to load options and name from meta.json
	let options: Template['options'] = [];
	let name = id.charAt(0).toUpperCase() + id.slice(1);
	const metaFile = path.join(templateDir, 'meta.json');
	if (fs.existsSync(metaFile)) {
		try {
			const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
			options = meta.options ?? [];
			if (meta.name) name = meta.name;
		} catch {
			console.warn(`Template "${id}": failed to parse meta.json, using defaults`);
		}
	}

	const template: Template = {
		id,
		name,
		builtIn: true,
		html,
		css,
		options,
		createdAt: '',
		updatedAt: ''
	};
	builtInCache.set(id, template);
	return template;
}

export const createTemplate = db.transaction((data: { name: string; html: string; css: string; options: Template['options'] }, userId?: string): Template => {
	const id = generateId();
	const now = new Date().toISOString();
	const template: Template = {
		id,
		name: data.name,
		builtIn: false,
		html: data.html,
		css: data.css,
		options: data.options,
		createdAt: now,
		updatedAt: now
	};
	insertDocument(id, 'template', template);
	if (userId) recordChange('template', id, 'create', {}, userId);
	return template;
});

export function updateTemplate(id: string, data: Partial<Template>, userId?: string): Template | null {
	return db.transaction(() => {
		// For built-in templates, create a DB override if none exists yet
		let existing = getDocument<Template>(id, 'template');
		if (!existing && BUILT_IN_TEMPLATES.includes(id)) {
			const builtIn = loadBuiltInTemplate(id);
			if (!builtIn) return null;
			// Seed a DB copy from the disk version
			insertDocument(id, 'template', { ...builtIn, builtIn: false });
			existing = getDocument<Template>(id, 'template');
			if (!existing) return null;
		}
		if (!existing) return null;

		const updated: Template = {
			...existing,
			...data,
			id,
			builtIn: false,
			createdAt: existing.createdAt,
			updatedAt: new Date().toISOString()
		};
		updateDocument(id, updated);
		if (userId) {
			// Log which fields changed (html/css summarized to avoid bloat)
			const diff = computeDiff(
				existing as unknown as Record<string, unknown>,
				updated as unknown as Record<string, unknown>
			);
			if (Object.keys(diff).length > 0) {
				recordChange('template', id, 'update', diff, userId);
			}
		}
		return updated;
	})();
}

const stmtCountByTemplateId = db.prepare(
	"SELECT COUNT(*) as count FROM documents WHERE type IN ('invoice', 'proposal') AND json_extract(data, '$.templateId') = ?"
);

export function removeTemplate(id: string, userId?: string): { deleted: boolean; error?: string } {
	if (BUILT_IN_TEMPLATES.includes(id)) return { deleted: false, error: 'Cannot delete built-in template' };
	return db.transaction(() => {
		const existing = getDocument<Template>(id, 'template');
		if (!existing) return { deleted: false, error: 'Template not found' };

		// Check if any documents reference this template
		const { count } = stmtCountByTemplateId.get(id) as { count: number };
		if (count > 0) {
			return { deleted: false, error: `Template is used by ${count} document${count > 1 ? 's' : ''}` };
		}

		deleteDocument(id);
		if (userId) recordChange('template', id, 'delete', {}, userId);
		return { deleted: true };
	})();
}
