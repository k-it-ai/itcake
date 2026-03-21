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
		const menuItems = [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
		const idx = menuItems.indexOf(document.activeElement as HTMLElement);
		if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
			e.preventDefault();
			menuItems[(idx + 1) % menuItems.length]?.focus();
		} else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
			e.preventDefault();
			menuItems[(idx - 1 + menuItems.length) % menuItems.length]?.focus();
		}
	}

	const items = [
		{ tKey: 'quickCreate.newTicket', href: '/tickets?new=1', icon: 'M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z' },
		{ tKey: 'quickCreate.newInvoice', href: '/invoices/new', icon: 'M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z' },
		{ tKey: 'quickCreate.newProposal', href: '/proposals/new', icon: 'M10.125 2.25h-4.5c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125v-9M10.125 2.25h.375a9 9 0 019 9v.375M10.125 2.25A3.375 3.375 0 0113.5 5.625v1.5c0 .621.504 1.125 1.125 1.125h1.5a3.375 3.375 0 012.625 1.26M9 15l2.25 2.25L15 12' },
		{ tKey: 'quickCreate.newClient', href: '/clients/new', icon: 'M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z' },
		{ tKey: 'quickCreate.newMonitor', href: '/uptime?new=1', icon: 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
		{ tKey: 'quickCreate.newAgent', href: '/agents?new=1', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z' },
	];
</script>

<div class="relative">
	<button
		bind:this={triggerEl}
		onclick={toggle}
		class="flex items-center justify-center rounded-lg bg-cyan hover:bg-cyan-dark text-white h-9 w-9 transition-all"
		aria-label={t('quickCreate.title')}
		aria-expanded={open}
		aria-haspopup="true"
	>
		<svg class="h-5 w-5 transition-transform duration-200 {open ? 'rotate-45' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
		</svg>
	</button>

	{#if open}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="fixed inset-0 z-40" role="presentation" onclick={close}></div>
		<div
			bind:this={menuEl}
			class="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 rounded-xl border border-border bg-bg-card shadow-xl p-1.5 flex gap-1"
			role="menu"
			tabindex="-1"
			transition:fade={{ duration: 100 }}
			onkeydown={handleMenuKeydown}
		>
			{#each items as item}
				<a
					href={item.href}
					onclick={close}
					role="menuitem"
					tabindex="-1"
					title={t(item.tKey)}
					class="flex items-center justify-center w-9 h-9 rounded-lg text-near-black/50 hover:bg-cyan/10 hover:text-cyan transition-colors focus:bg-cyan/10 focus:text-cyan focus:outline-none"
				>
					<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
					</svg>
				</a>
			{/each}
		</div>
	{/if}
</div>
