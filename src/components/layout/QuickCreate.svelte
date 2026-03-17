<script lang="ts">
	import { tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import { t } from '$lib/i18n/index.svelte.js';

	let open = $state(false);
	let menuEl: HTMLDivElement | undefined = $state();
	let triggerEl: HTMLButtonElement | undefined = $state();

	function close() {
		open = false;
		triggerEl?.focus();
	}

	function toggle() {
		open = !open;
		if (open) {
			tick().then(() => {
				const first = menuEl?.querySelector<HTMLElement>('[role="menuitem"]');
				first?.focus();
			});
		}
	}

	function handleMenuKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') { close(); return; }
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const menuItems = [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
			const idx = menuItems.indexOf(document.activeElement as HTMLElement);
			const next = e.key === 'ArrowDown' ? (idx + 1) % menuItems.length : (idx - 1 + menuItems.length) % menuItems.length;
			menuItems[next]?.focus();
		}
	}

	const items = [
		{ tKey: 'quickCreate.newInvoice', href: '/invoices/new', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
		{ tKey: 'quickCreate.newProposal', href: '/proposals/new', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
		{ tKey: 'quickCreate.newClient', href: '/clients/new', icon: 'M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z' },
	];
</script>

<div class="relative">
	<button
		bind:this={triggerEl}
		onclick={toggle}
		class="flex items-center justify-center rounded-lg bg-cyan hover:bg-cyan-dark text-white h-9 w-9 transition-colors"
		aria-label={t('quickCreate.title')}
		aria-expanded={open}
		aria-haspopup="true"
	>
		<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
		</svg>
	</button>

	{#if open}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="fixed inset-0 z-40" role="presentation" onclick={close}></div>
		<div
			bind:this={menuEl}
			class="absolute right-0 top-full mt-2 z-50 w-48 rounded-lg border border-border bg-bg-card shadow-lg py-1"
			role="menu"
			tabindex="-1"
			transition:fade={{ duration: 120 }}
			onkeydown={handleMenuKeydown}
		>
			{#each items as item}
				<a
					href={item.href}
					onclick={close}
					role="menuitem"
					tabindex="-1"
					class="flex items-center gap-3 px-4 py-2.5 text-sm text-near-black/80 hover:bg-bg/50 hover:text-near-black transition-colors focus:bg-bg/50 focus:outline-none"
				>
					<svg class="h-4 w-4 text-near-black/60" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
					</svg>
					{t(item.tKey)}
				</a>
			{/each}
		</div>
	{/if}
</div>
