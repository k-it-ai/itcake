/**
 * ⌘K command palette state.
 *
 * Per assets/design/handoff-v2/04-shell.md the palette is a portalled overlay
 * with: search input, scope chips, grouped results, footer hint. State lives
 * here so any page can call `palette.open()` / push results to the index;
 * CommandPalette.svelte renders against it.
 *
 * Scope vocabulary: All · Invoices · Tickets · Clients · Agents · Commands.
 * Result row shape: { group, icon, label, meta?, action }.
 *
 * Notes:
 * - Last query is persisted in-module for 30 s after close (spec). After that
 *   re-opens start blank.
 * - This store does NOT do the searching itself — pages register search
 *   providers that resolve a query → results. Keeps the palette decoupled
 *   from /api/search etc.
 */
import type { ComponentType, SvelteComponent } from 'svelte';

export type PaletteScope = 'all' | 'invoices' | 'tickets' | 'clients' | 'agents' | 'commands';

// lucide-svelte v1.x still ships components as legacy class types
// (SvelteComponentTyped); accept any class component for icon slots.
type IconComponent = ComponentType<SvelteComponent<Record<string, any>, any, any>>;

export interface PaletteResult {
	id: string;
	group: string;
	groupTKey?: string;
	icon?: IconComponent;
	label: string;
	meta?: string;
	href?: string;
	action?: () => void | Promise<void>;
}

export type PaletteProvider = (query: string, scope: PaletteScope) => Promise<PaletteResult[]> | PaletteResult[];

const RESET_AFTER_MS = 30_000;

let isOpen = $state(false);
let query = $state('');
let scope = $state<PaletteScope>('all');
let results = $state<PaletteResult[]>([]);
let highlightIndex = $state(0);
let loading = $state(false);

let lastClosedAt = 0;
const providers: PaletteProvider[] = [];

let runningController: AbortController | null = null;

export const palette = {
	get open() {
		return isOpen;
	},
	get query() {
		return query;
	},
	set query(v: string) {
		query = v;
		highlightIndex = 0;
	},
	get scope() {
		return scope;
	},
	set scope(v: PaletteScope) {
		scope = v;
		highlightIndex = 0;
	},
	get results() {
		return results;
	},
	get highlightIndex() {
		return highlightIndex;
	},
	set highlightIndex(v: number) {
		highlightIndex = Math.max(0, Math.min(v, Math.max(0, results.length - 1)));
	},
	get loading() {
		return loading;
	},
	openPalette() {
		isOpen = true;
		const sinceClose = Date.now() - lastClosedAt;
		if (sinceClose > RESET_AFTER_MS) {
			query = '';
			scope = 'all';
			results = [];
		}
		highlightIndex = 0;
	},
	close() {
		isOpen = false;
		lastClosedAt = Date.now();
		query = '';
		results = [];
		runningController?.abort();
		runningController = null;
		loading = false;
	},
	toggle() {
		if (isOpen) palette.close();
		else palette.openPalette();
	},
	moveUp() {
		highlightIndex = Math.max(0, highlightIndex - 1);
	},
	moveDown() {
		highlightIndex = Math.min(results.length - 1, highlightIndex + 1);
	},
	setResults(next: PaletteResult[]) {
		results = next;
		highlightIndex = 0;
	},
	registerProvider(p: PaletteProvider): () => void {
		providers.push(p);
		return () => {
			const i = providers.indexOf(p);
			if (i >= 0) providers.splice(i, 1);
		};
	},
	async runProviders(): Promise<void> {
		runningController?.abort();
		const controller = new AbortController();
		runningController = controller;
		loading = true;
		try {
			const collected: PaletteResult[] = [];
			for (const p of providers) {
				if (controller.signal.aborted) return;
				const res = await p(query, scope);
				if (controller.signal.aborted) return;
				collected.push(...res);
			}
			results = collected;
			highlightIndex = 0;
		} finally {
			if (!controller.signal.aborted) loading = false;
		}
	},
	activate(idx?: number): void {
		const i = idx ?? highlightIndex;
		const r = results[i];
		if (!r) return;
		palette.close();
		if (r.action) {
			void r.action();
		}
	}
};
