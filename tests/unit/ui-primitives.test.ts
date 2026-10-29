/**
 * UI primitive smoke tests.
 *
 * The vitest config runs in `environment: 'node'` so we cannot mount Svelte
 * components in a DOM. Instead we:
 *
 * 1. Compile each primitive through `svelte/compiler.compile()` to assert it
 *    parses + compiles without errors or warnings.
 * 2. Server-render each one via `svelte/server.render` with key props (using
 *    `createRawSnippet` for snippet props) to verify prop pass-through.
 *
 * This catches typos, malformed templates, broken prop interfaces, and
 * renames of `#lib/icons` re-exports. Visual regressions are out of scope.
 *
 * `testTimeout` is bumped because the first test that imports a primitive
 * triggers vite's transform of lucide-svelte's whole icon module graph
 * (cold cache).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'svelte/server';
import { createRawSnippet, type Component, type Snippet } from 'svelte';

const UI_DIR = path.resolve('src/lib/components/ui');

function textSnippet(text: string): Snippet {
	return createRawSnippet(() => ({
		render: () => `<span>${text}</span>`
	}));
}

const componentCache = new Map<string, Component>();

async function loadComponent(name: string): Promise<Component> {
	const cached = componentCache.get(name);
	if (cached) return cached;
	const mod = await import(/* @vite-ignore */ path.join(UI_DIR, `${name}.svelte`));
	const component = mod.default as Component;
	componentCache.set(name, component);
	return component;
}

const PRIMITIVES = [
	'Tag',
	'Dot',
	'Btn',
	'FilterChip',
	'StatusPill',
	'Bar',
	'Spark',
	'Avatar',
	'Card',
	'SectionHead',
	'Toggle',
	'EmptyState',
	'ErrorState',
	'Kbd',
	'Pager'
] as const;

describe('UI primitives — compile parity', () => {
	for (const name of PRIMITIVES) {
		it(`${name}.svelte compiles without errors or warnings`, () => {
			const source = readFileSync(path.join(UI_DIR, `${name}.svelte`), 'utf8');
			const result = compile(source, { generate: 'server', filename: `${name}.svelte` });
			expect(result.js).toBeTruthy();
			expect(result.warnings).toEqual([]);
		});
	}
});

describe('UI primitives — prop pass-through (server render)', () => {
	// Eagerly load every primitive once so the cold lucide-svelte transform
	// hits this beforeAll instead of whichever test happens to compile first.
	beforeAll(async () => {
		await Promise.all(PRIMITIVES.map(loadComponent));
	}, 60_000);

	it('Tag renders children with tone class', async () => {
		const Tag = await loadComponent('Tag');
		const out = render(Tag, { props: { tone: 'bad', children: textSnippet('crit') } });
		expect(out.body).toContain('crit');
		expect(out.body).toContain('rounded-full');
	});

	it('Dot renders an aria-hidden circle by default', async () => {
		const Dot = await loadComponent('Dot');
		const out = render(Dot, { props: { tone: 'good' } });
		expect(out.body).toContain('rounded-full');
		expect(out.body).toContain('#1f8a5b');
	});

	it('Btn renders children with primary background', async () => {
		const Btn = await loadComponent('Btn');
		const out = render(Btn, {
			props: { variant: 'primary', children: textSnippet('Save') }
		});
		expect(out.body).toContain('Save');
		expect(out.body).toContain('var(--brand)');
	});

	it('FilterChip renders label and value', async () => {
		const FilterChip = await loadComponent('FilterChip');
		const out = render(FilterChip, { props: { label: 'Status', value: 'Open', active: true } });
		expect(out.body).toContain('Status');
		expect(out.body).toContain('Open');
		expect(out.body).toContain('aria-pressed="true"');
	});

	it('StatusPill renders text and chevron when action=true', async () => {
		const StatusPill = await loadComponent('StatusPill');
		const out = render(StatusPill, {
			props: { tone: 'bad', action: true, children: textSnippet('overdue') }
		});
		expect(out.body).toContain('overdue');
		expect(out.body).toContain('aria-haspopup="menu"');
	});

	it('Bar renders progressbar role with aria-valuenow', async () => {
		const Bar = await loadComponent('Bar');
		const out = render(Bar, { props: { pct: 42, tone: 'good' } });
		expect(out.body).toContain('role="progressbar"');
		expect(out.body).toContain('aria-valuenow="42"');
	});

	it('Spark renders an svg polyline for non-empty data', async () => {
		const Spark = await loadComponent('Spark');
		const out = render(Spark, { props: { data: [1, 2, 3, 2, 4] } });
		expect(out.body).toContain('<svg');
		expect(out.body).toContain('<polyline');
	});

	it('Avatar renders initials from a two-token name', async () => {
		const Avatar = await loadComponent('Avatar');
		const out = render(Avatar, { props: { name: 'Jane Doe' } });
		expect(out.body).toContain('JD');
	});

	it('Card renders children with default 14px padding', async () => {
		const Card = await loadComponent('Card');
		const out = render(Card, { props: { children: textSnippet('inner') } });
		expect(out.body).toContain('inner');
		expect(out.body).toContain('padding:14px');
	});

	it('SectionHead renders title and sub', async () => {
		const SectionHead = await loadComponent('SectionHead');
		const out = render(SectionHead, { props: { title: 'Boot', sub: 'avg 22s' } });
		expect(out.body).toContain('Boot');
		expect(out.body).toContain('avg 22s');
	});

	it('Toggle renders a switch with aria-checked', async () => {
		const Toggle = await loadComponent('Toggle');
		const out = render(Toggle, { props: { checked: true, ariaLabel: 'auto-update' } });
		expect(out.body).toContain('role="switch"');
		expect(out.body).toContain('aria-checked="true"');
	});

	it('EmptyState renders title and description', async () => {
		const EmptyState = await loadComponent('EmptyState');
		const out = render(EmptyState, {
			props: { title: 'No invoices yet', description: 'Create your first invoice.' }
		});
		expect(out.body).toContain('No invoices yet');
		expect(out.body).toContain('Create your first invoice.');
	});

	it('ErrorState renders title, message and retry button', async () => {
		const ErrorState = await loadComponent('ErrorState');
		const out = render(ErrorState, {
			props: { title: "Couldn't load", message: 'boom', retry: () => {}, retryLabel: 'Retry' }
		});
		expect(out.body).toContain("Couldn't load");
		expect(out.body).toContain('boom');
		expect(out.body).toContain('Retry');
	});

	it('Kbd renders the chord text', async () => {
		const Kbd = await loadComponent('Kbd');
		const out = render(Kbd, { props: { keys: '⌘K' } });
		expect(out.body).toContain('⌘K');
	});

	it('Pager renders the visible range and marks the current page', async () => {
		const Pager = await loadComponent('Pager');
		const out = render(Pager, { props: { total: 120, page: 2, pageSize: 25, onchange: () => {} } });
		expect(out.body).toContain('26–50');
		expect(out.body).toContain('aria-current="page"');
	});

	it('Pager hides itself when everything fits on one page', async () => {
		const Pager = await loadComponent('Pager');
		const out = render(Pager, { props: { total: 10, page: 1, onchange: () => {} } });
		expect(out.body).not.toContain('<nav');
	});
});
