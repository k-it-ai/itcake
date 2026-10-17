<script module lang="ts">
	let openModals = 0;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { tick } from 'svelte';
	import { t } from '#lib/i18n/index.svelte.js';

	interface Props {
		open: boolean;
		title?: string;
		onclose: () => void;
		children: Snippet;
		actions?: Snippet;
	}

	let { open = $bindable(false), title = '', onclose, children, actions }: Props = $props();

	const modalTitleId = `modal-title-${crypto.randomUUID().slice(0, 8)}`;
	let contentEl: HTMLDivElement | undefined = $state();
	let previousFocusEl = $state<Element | null>(null);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation(); // Prevent parent handlers (e.g. sidebar close) from also firing
			onclose();
			return;
		}
		if (e.key === 'Tab' && contentEl) {
			const focusable = contentEl.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	function handleBackdrop() {
		onclose();
	}

	$effect(() => {
		if (open) {
			previousFocusEl = document.activeElement;
			openModals++;
			document.body.style.overflow = 'hidden';
			tick().then(() => {
				if (!contentEl) return;
				const focusable = contentEl.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
				);
				if (focusable.length > 0) focusable[0].focus();
				else contentEl.focus();
			});
			return () => {
				openModals--;
				if (openModals <= 0) {
					openModals = 0;
					document.body.style.overflow = '';
				}
				if (previousFocusEl instanceof HTMLElement && document.body.contains(previousFocusEl)) {
					previousFocusEl.focus();
				}
				previousFocusEl = null;
			};
		}
	});
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center"
		role="dialog"
		aria-modal="true"
		aria-labelledby={title ? modalTitleId : undefined}
		aria-label={title ? undefined : t('aria.dialog')}
		tabindex="-1"
		onkeydown={handleKeydown}
	>
		<!-- Backdrop — hidden from AT since Escape handles dismissal -->
		<div
			class="absolute inset-0 bg-black/50"
			onclick={handleBackdrop}
			role="presentation"
			aria-hidden="true"
			transition:fade={{ duration: 150 }}
		></div>

		<!-- Modal content -->
		<!-- tabindex="-1" allows programmatic focus when no focusable children exist -->
		<div
			class="relative z-10 w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl bg-card shadow-xl mx-4"
			bind:this={contentEl}
			tabindex="-1"
			transition:scale={{ duration: 150, start: 0.95 }}
		>
			{#if title}
				<div class="flex items-center justify-between border-b border-line px-6 py-4">
					<h2 id={modalTitleId} class="text-lg font-semibold text-ink">{title}</h2>
					<button onclick={onclose} class="p-2 text-ink/60 hover:text-ink" aria-label={t('action.close')}>
						<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
			{/if}

			<div class="px-6 py-4">
				{@render children()}
			</div>

			{#if actions}
				<div class="flex justify-end gap-3 border-t border-line px-6 py-4">
					{@render actions()}
				</div>
			{/if}
		</div>
	</div>
{/if}
