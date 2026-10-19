<script lang="ts">
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { t } from '#lib/i18n/index.svelte.js';
	import { navGroups, isActive, type NavItem } from '#lib/stores/nav.svelte.js';
	import { ChevronDown, LogOut } from '#lib/icons/index.js';

	interface Props {
		userName?: string;
		userEmail?: string;
		userRole?: string;
	}

	const { userName = 'Operator', userEmail = '', userRole = 'Owner' }: Props = $props();

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) return 'OP';
		if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
		return (parts[0][0] + parts[1][0]).toUpperCase();
	}

	const inits = $derived(initials(userName));

	let userMenuOpen = $state(false);

	function badgeClasses(item: NavItem): string {
		if (item.badgeTone === 'bad') {
			return 'bg-[rgba(168,35,44,0.22)] text-[#ff8f96]';
		}
		return 'bg-[rgba(255,255,255,0.10)] text-[#cfd6dd]';
	}
</script>

<aside
	class="flex h-screen w-[228px] shrink-0 flex-col text-[12.5px]"
	style="background: var(--nav); color: #dde3ea;"
>
	<div class="flex items-start gap-3 p-4">
		<div
			class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-semibold"
			style="background: var(--brand-2); color: var(--brand-ink);"
			aria-hidden="true"
		>K</div>
		<div class="min-w-0 leading-tight">
			<div class="text-[13px] font-semibold" style="color: #f3f6f9;">ITCake</div>
			<div class="text-[10px]" style="color: var(--nav-mute);">Operator workspace</div>
		</div>
	</div>

	<nav class="flex-1 overflow-auto px-2" aria-label={t('aria.main')}>
		{#each navGroups as group, gIdx (group.id)}
			<div class="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider {gIdx === 0 ? 'mt-1' : 'mt-3'}" style="color: var(--nav-mute);">
				{t(group.tKey)}
			</div>
			{#each group.items as item (item.id)}
				{@const active = isActive(item, page.url.pathname)}
				{@const Icon = item.icon}
				{@const badgeValue = item.badge?.() ?? 0}
				<a
					href={item.href}
					aria-current={active ? 'page' : undefined}
					class="group flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2"
					style="color: {active ? 'var(--nav-active-text)' : '#dde3ea'}; background: {active ? 'var(--nav-active)' : 'transparent'}; --tw-ring-color: var(--brand-2);"
					onmouseenter={(e) => { if (!active) (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(255,255,255,.04)'; }}
					onmouseleave={(e) => { if (!active) (e.currentTarget as HTMLAnchorElement).style.background = 'transparent'; }}
				>
					<Icon size={16} strokeWidth={1.6} class={active ? '' : 'opacity-80'} aria-hidden="true" />
					<span class="flex-1 truncate">{t(item.tKey)}</span>
					{#if badgeValue > 0}
						<span class="ml-auto inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-px text-[10.5px] font-medium tabular-nums {badgeClasses(item)}">
							{badgeValue}
						</span>
					{/if}
				</a>
			{/each}
		{/each}
	</nav>

	<div class="m-2 rounded-lg border" style="border-color: var(--nav-line); background: rgba(255,255,255,.02);">
		<button
			type="button"
			aria-haspopup="menu"
			aria-expanded={userMenuOpen}
			onclick={() => (userMenuOpen = !userMenuOpen)}
			class="flex w-full items-center gap-2.5 rounded-lg p-2.5 text-left focus-visible:outline-none focus-visible:ring-2"
			style="--tw-ring-color: var(--brand-2);"
		>
			<div
				class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[11px] font-semibold tabular-nums"
				style="background: rgba(255,255,255,.08); color: #f3f6f9;"
				aria-hidden="true"
			>{inits}</div>
			<div class="min-w-0 flex-1 leading-tight">
				<div class="truncate text-[12.5px] font-medium" style="color: #f3f6f9;">{userName}</div>
				<div class="truncate text-[10.5px]" style="color: var(--nav-mute);">
					{#if userEmail}{userEmail} · {/if}{userRole}
				</div>
			</div>
			<ChevronDown size={14} strokeWidth={1.6} class="opacity-60 transition-transform {userMenuOpen ? 'rotate-180' : ''}" aria-hidden="true" />
		</button>

		{#if userMenuOpen}
			<div role="menu" class="border-t px-1.5 py-1.5" style="border-color: var(--nav-line);">
				<form method="POST" action="/logout" use:enhance={() => {
					return async ({ update }) => {
						userMenuOpen = false;
						await update();
					};
				}}>
					<button
						type="submit"
						role="menuitem"
						class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] focus-visible:outline-none focus-visible:ring-2"
						style="color: #dde3ea; --tw-ring-color: var(--brand-2);"
						onmouseenter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,.04)'; }}
						onmouseleave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
					>
						<LogOut size={14} strokeWidth={1.6} aria-hidden="true" />
						<span>{t('sidebar.logout')}</span>
					</button>
				</form>
			</div>
		{/if}
	</div>
</aside>
