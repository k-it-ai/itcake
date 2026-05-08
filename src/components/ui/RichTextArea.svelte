<script lang="ts">
	import { tick, onMount } from 'svelte';
	import { t } from '$lib/i18n/index.svelte.js';

	interface Props {
		value?: string;
		placeholder?: string;
		label?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		name?: string;
		rows?: number;
		class?: string;
	}

	let {
		value = $bindable(''),
		placeholder = '',
		label = '',
		error = '',
		required = false,
		disabled = false,
		name = '',
		rows = 4,
		class: className = ''
	}: Props = $props();

	let editor = $state<HTMLDivElement>();
	let hiddenInput = $state<HTMLInputElement>();
	let slug = $derived(label.replace(/\s+/g, '-').toLowerCase());
	let inputId = $derived(name || (slug ? `richtext-${slug}` : `richtext-${crypto.randomUUID().slice(0, 8)}`));

	let activeBold = $state(false);
	let activeItalic = $state(false);
	let activeUnderline = $state(false);
	let activeUl = $state(false);
	let activeOl = $state(false);

	let internalUpdate = false;

	onMount(() => {
		if (editor && value) {
			setEditorContent(value);
		}
	});

	let prevValue = value;
	$effect(() => {
		const v = value;
		if (editor && v !== prevValue) {
			if (internalUpdate) {
				internalUpdate = false;
			} else {
				const saved = saveSelection();
				setEditorContent(v);
				if (saved) {
					tick().then(() => restoreSelection(saved));
				}
			}
			prevValue = v;
		}
	});

	function setEditorContent(html: string) {
		if (!editor) return;
		while (editor.firstChild) editor.removeChild(editor.firstChild);
		if (!html) return;
		const frag = sanitizeToFragment(html);
		editor.appendChild(frag);
	}

	function getEditorHtml(): string {
		if (!editor) return '';
		let html = '';
		for (const child of Array.from(editor.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) {
				html += child.textContent ?? '';
			} else if (child.nodeType === Node.ELEMENT_NODE) {
				html += (child as Element).outerHTML;
			}
		}
		return html;
	}

	function syncValue() {
		if (!editor) return;
		const html = getEditorHtml();
		const normalized = html === '<br>' || html === '<br/>' || html === '<div><br></div>' || html === '<div><br/></div>' ? '' : html;
		if (normalized !== value) {
			internalUpdate = true;
			value = normalized;
		}
		if (hiddenInput) hiddenInput.value = normalized;
	}

	function updateActiveStates() {
		activeBold = document.queryCommandState('bold');
		activeItalic = document.queryCommandState('italic');
		activeUnderline = document.queryCommandState('underline');
		activeUl = document.queryCommandState('insertUnorderedList');
		activeOl = document.queryCommandState('insertOrderedList');
	}

	function execFormat(command: string, val?: string) {
		editor?.focus();
		document.execCommand(command, false, val);
		syncValue();
		updateActiveStates();
	}

	function handleInput() {
		syncValue();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Tab' && (activeUl || activeOl)) {
			e.preventDefault();
			if (e.shiftKey) {
				document.execCommand('outdent', false);
			} else {
				document.execCommand('indent', false);
			}
			syncValue();
			return;
		}
	}

	function handleSelectionChange() {
		if (!editor) return;
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;
		if (editor.contains(sel.anchorNode)) {
			updateActiveStates();
		}
	}

	function insertFragmentAtCursor(frag: DocumentFragment) {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;
		const range = sel.getRangeAt(0);
		range.deleteContents();
		const lastNode = frag.lastChild;
		range.insertNode(frag);
		if (lastNode) {
			range.setStartAfter(lastNode);
			range.collapse(true);
			sel.removeAllRanges();
			sel.addRange(range);
		}
	}

	function handlePaste(e: ClipboardEvent) {
		e.preventDefault();
		const html = e.clipboardData?.getData('text/html');
		const text = e.clipboardData?.getData('text/plain') || '';

		if (html) {
			const frag = sanitizeToFragment(html);
			insertFragmentAtCursor(frag);
		} else {
			const frag = document.createDocumentFragment();
			const lines = text.split('\n');
			lines.forEach((line, i) => {
				if (i > 0) frag.appendChild(document.createElement('br'));
				if (line) frag.appendChild(document.createTextNode(line));
			});
			insertFragmentAtCursor(frag);
		}
		syncValue();
	}

	const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'BR', 'P', 'DIV', 'SPAN', 'SUB', 'SUP']);

	function sanitizeToFragment(html: string): DocumentFragment {
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');

		function clean(node: Node): Node | null {
			if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
			if (node.nodeType !== Node.ELEMENT_NODE) return null;

			const el = node as Element;
			const tag = el.tagName;

			if (ALLOWED_TAGS.has(tag)) {
				const clone = document.createElement(tag);
				for (const child of Array.from(el.childNodes)) {
					const cleaned = clean(child);
					if (cleaned) clone.appendChild(cleaned);
				}
				return clone;
			} else {
				const frag = document.createDocumentFragment();
				for (const child of Array.from(el.childNodes)) {
					const cleaned = clean(child);
					if (cleaned) frag.appendChild(cleaned);
				}
				return frag;
			}
		}

		const frag = document.createDocumentFragment();
		for (const child of Array.from(doc.body.childNodes)) {
			const cleaned = clean(child);
			if (cleaned) frag.appendChild(cleaned);
		}
		return frag;
	}

	interface SavedSelection { startPath: number[]; startOffset: number; endPath: number[]; endOffset: number; }

	function getNodePath(root: Node, node: Node): number[] {
		const path: number[] = [];
		let current: Node | null = node;
		while (current && current !== root) {
			const parent: Node | null = current.parentNode;
			if (!parent) break;
			path.unshift(Array.from(parent.childNodes).indexOf(current as ChildNode));
			current = parent;
		}
		return path;
	}

	function getNodeFromPath(root: Node, path: number[]): Node | null {
		let current: Node = root;
		for (const idx of path) {
			if (!current.childNodes[idx]) return null;
			current = current.childNodes[idx];
		}
		return current;
	}

	function saveSelection(): SavedSelection | null {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || !editor) return null;
		const range = sel.getRangeAt(0);
		if (!editor.contains(range.startContainer)) return null;
		return {
			startPath: getNodePath(editor, range.startContainer),
			startOffset: range.startOffset,
			endPath: getNodePath(editor, range.endContainer),
			endOffset: range.endOffset
		};
	}

	function restoreSelection(saved: SavedSelection) {
		if (!editor) return;
		const sel = window.getSelection();
		if (!sel) return;
		const startNode = getNodeFromPath(editor, saved.startPath);
		const endNode = getNodeFromPath(editor, saved.endPath);
		if (!startNode || !endNode) return;
		try {
			const range = document.createRange();
			range.setStart(startNode, Math.min(saved.startOffset, startNode.textContent?.length ?? 0));
			range.setEnd(endNode, Math.min(saved.endOffset, endNode.textContent?.length ?? 0));
			sel.removeAllRanges();
			sel.addRange(range);
		} catch {
		}
	}

	onMount(() => {
		document.addEventListener('selectionchange', handleSelectionChange);
		return () => document.removeEventListener('selectionchange', handleSelectionChange);
	});

	function btnClass(active: boolean): string {
		const base = 'rounded p-1.5 transition-colors';
		return active
			? `${base} text-cyan bg-cyan/10`
			: `${base} text-near-black/60 hover:text-near-black hover:bg-near-black/10`;
	}

	const minHeight = `${rows * 1.5}em`;
</script>

<div class="space-y-1 {className}">
	{#if label}
		<span class="block text-sm font-medium text-near-black cursor-pointer" id="{inputId}-label" role="button" tabindex="-1" onclick={() => document.getElementById(inputId)?.focus()} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') document.getElementById(inputId)?.focus(); }}>
			{label}
			{#if required}<span class="text-red dark:text-red-300">*</span>{/if}
		</span>
	{/if}
	<div class="rounded-lg border transition-colors {error ? 'border-red' : 'border-border'} focus-within:border-cyan focus-within:ring-1 focus-within:ring-cyan">
		<!-- Toolbar: onmousedown preventDefault stops it from stealing focus/selection from editor -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="flex items-center gap-0.5 border-b border-border px-2 py-1 bg-bg rounded-t-lg"
			onmousedown={(e) => e.preventDefault()}
		>
			<button
				type="button"
				onclick={() => execFormat('bold')}
				class={btnClass(activeBold)}
				title={t('aria.bold') + ' (Ctrl+B)'}
				aria-label={t('aria.bold')}
				aria-pressed={activeBold}
				tabindex={-1}
			>
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<path d="M7 5h6a3.5 3.5 0 010 7H7V5z"/>
					<path d="M7 12h7a3.5 3.5 0 010 7H7v-7z"/>
				</svg>
			</button>
			<button
				type="button"
				onclick={() => execFormat('italic')}
				class={btnClass(activeItalic)}
				title={t('aria.italic') + ' (Ctrl+I)'}
				aria-label={t('aria.italic')}
				aria-pressed={activeItalic}
				tabindex={-1}
			>
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<line x1="19" y1="4" x2="10" y2="4" />
					<line x1="14" y1="20" x2="5" y2="20" />
					<line x1="15" y1="4" x2="9" y2="20" />
				</svg>
			</button>
			<button
				type="button"
				onclick={() => execFormat('underline')}
				class={btnClass(activeUnderline)}
				title={t('aria.underline') + ' (Ctrl+U)'}
				aria-label={t('aria.underline')}
				aria-pressed={activeUnderline}
				tabindex={-1}
			>
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M6 3v7a6 6 0 006 6 6 6 0 006-6V3" />
					<line x1="4" y1="21" x2="20" y2="21" />
				</svg>
			</button>

			<span class="mx-1 h-4 w-px bg-border"></span>

			<button
				type="button"
				onclick={() => execFormat('insertUnorderedList')}
				class={btnClass(activeUl)}
				title={t('aria.bulletList')}
				aria-label={t('aria.bulletList')}
				aria-pressed={activeUl}
				tabindex={-1}
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
				</svg>
			</button>
			<button
				type="button"
				onclick={() => execFormat('insertOrderedList')}
				class={btnClass(activeOl)}
				title={t('aria.numberedList')}
				aria-label={t('aria.numberedList')}
				aria-pressed={activeOl}
				tabindex={-1}
			>
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
					<text x="1" y="8" font-size="7" font-family="system-ui">1.</text>
					<text x="1" y="15" font-size="7" font-family="system-ui">2.</text>
					<text x="1" y="22" font-size="7" font-family="system-ui">3.</text>
					<line x1="10" y1="6" x2="23" y2="6" stroke="currentColor" stroke-width="1.5" />
					<line x1="10" y1="13" x2="23" y2="13" stroke="currentColor" stroke-width="1.5" />
					<line x1="10" y1="20" x2="23" y2="20" stroke="currentColor" stroke-width="1.5" />
				</svg>
			</button>
			<button
				type="button"
				onclick={() => execFormat('indent')}
				class="rounded p-1.5 text-near-black/60 hover:text-near-black hover:bg-near-black/10 transition-colors"
				title={t('aria.indent') + ' (Tab)'}
				aria-label={t('aria.indent')}
				tabindex={-1}
			>
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M11 6h10M11 12h10M11 18h10M3 8l4 4-4 4" />
				</svg>
			</button>
			<button
				type="button"
				onclick={() => execFormat('outdent')}
				class="rounded p-1.5 text-near-black/60 hover:text-near-black hover:bg-near-black/10 transition-colors"
				title={t('aria.outdent') + ' (Shift+Tab)'}
				aria-label={t('aria.outdent')}
				tabindex={-1}
			>
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M11 6h10M11 12h10M11 18h10M7 8l-4 4 4 4" />
				</svg>
			</button>
		</div>
		<!-- Editable area -->
		<div class="relative">
			<!-- svelte-ignore a11y_interactive_supports_focus -->
			<div
				bind:this={editor}
				id={inputId}
				role="textbox"
				aria-labelledby={label ? `${inputId}-label` : undefined}
				aria-label={label ? undefined : t('aria.richTextEditor')}
				aria-multiline="true"
				contenteditable={disabled ? 'false' : 'true'}
				oninput={handleInput}
				onkeydown={handleKeydown}
				onpaste={handlePaste}
				class="richtext-editor w-full bg-transparent text-near-black px-3 py-2 text-sm outline-none disabled:bg-bg rounded-b-lg overflow-y-auto cursor-text"
				style="min-height: {minHeight};"
			></div>
			{#if !value}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="pointer-events-none absolute inset-0 px-3 py-2 text-sm text-near-black/40 select-none"
					aria-hidden="true"
				>{placeholder}</div>
			{/if}
		</div>
	</div>
	<!-- Hidden input for form submission -->
	<input type="hidden" {name} bind:this={hiddenInput} value={value} />
	{#if error}
		<p class="text-sm text-red dark:text-red-300">{error}</p>
	{/if}
</div>

<style>
	.richtext-editor :global(ul),
	.richtext-editor :global(ol) {
		padding-left: 1.5em;
		margin: 0.25em 0;
	}
	.richtext-editor :global(ul) {
		list-style-type: disc;
	}
	.richtext-editor :global(ol) {
		list-style-type: decimal;
	}
	.richtext-editor :global(ul ul),
	.richtext-editor :global(ol ul) {
		list-style-type: circle;
	}
	.richtext-editor :global(ul ul ul),
	.richtext-editor :global(ol ul ul),
	.richtext-editor :global(ol ol ul) {
		list-style-type: square;
	}
	.richtext-editor :global(ol ol) {
		list-style-type: lower-alpha;
	}
	.richtext-editor :global(li) {
		margin: 0.1em 0;
	}
	.richtext-editor :global(p) {
		margin: 0;
	}
	.richtext-editor:empty::before {
		content: '\00a0';
		visibility: hidden;
	}
</style>
