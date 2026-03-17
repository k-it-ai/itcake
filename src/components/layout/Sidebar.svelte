<script lang="ts">
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { theme } from '$lib/stores/theme.svelte.js';
	import { t } from '$lib/i18n/index.svelte.js';

	interface NavItem {
		tKey: string;
		href: string;
		icon: string;
	}

	interface Props {
		collapsed?: boolean;
		isMobile?: boolean;
	}

	let { collapsed = $bindable(false), isMobile = false }: Props = $props();

	const navItems: NavItem[] = [
		{ tKey: 'sidebar.dashboard', href: '/dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
		{ tKey: 'sidebar.clients', href: '/clients', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
		{ tKey: 'sidebar.invoices', href: '/invoices', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
		{ tKey: 'sidebar.proposals', href: '/proposals', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
		{ tKey: 'sidebar.catalog', href: '/catalog', icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
		{ tKey: 'sidebar.expenses', href: '/expenses', icon: 'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z' },
		{ tKey: 'sidebar.reports', href: '/reports', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
		{ tKey: 'sidebar.templates', href: '/templates', icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z' },
		{ tKey: 'sidebar.uptime', href: '/uptime', icon: 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
		{ tKey: 'sidebar.changes', href: '/changes', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
		{ tKey: 'sidebar.settings', href: '/settings', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
	];

	function isActive(href: string, pathname: string): boolean {
		if (href === '/dashboard') return pathname === '/dashboard';
		return pathname.startsWith(href);
	}
</script>

<aside
	class="flex h-screen flex-col bg-sidebar text-white transition-[width,transform] duration-200 ease-in-out
		fixed z-40 lg:relative
		{collapsed ? 'w-16 -translate-x-full lg:translate-x-0' : 'w-60 translate-x-0'}"
	inert={collapsed && isMobile ? true : undefined}
>
	<!-- Header + Collapse toggle -->
	<div class="px-2 pt-3 pb-2">
		<button
			onclick={() => collapsed = !collapsed}
			title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
			aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
			class="flex items-center gap-3 rounded-lg px-3 py-2 w-full text-white/70 hover:bg-white/10 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
		>
			<svg class="h-5 w-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				{#if collapsed}
					<path stroke-linecap="round" stroke-linejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
				{:else}
					<path stroke-linecap="round" stroke-linejoin="round" d="M11 19l-7-7 7-7M19 19l-7-7 7-7" />
				{/if}
			</svg>
			<span class="text-lg font-bold whitespace-nowrap overflow-hidden transition-opacity duration-200 {collapsed ? 'opacity-0 w-0' : 'opacity-100'}">ITCake</span>
		</button>
	</div>

	<!-- Navigation -->
	<nav class="flex-1 space-y-1 overflow-y-auto px-2 py-2" aria-label={t('aria.main')}>
		{#each navItems as item}
			<a
				href={item.href}
				onclick={() => { if (isMobile) collapsed = true; }}
				title={collapsed ? t(item.tKey) : ''}
				aria-label={collapsed ? t(item.tKey) : undefined}
				aria-current={isActive(item.href, page.url.pathname) ? 'page' : undefined}
				class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50
					{isActive(item.href, page.url.pathname)
						? 'bg-sidebar-active text-white'
						: 'text-white/70 hover:bg-white/10 hover:text-white'}"
			>
				<svg class="h-5 w-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
				</svg>
				<span class="whitespace-nowrap overflow-hidden transition-opacity duration-200 {collapsed ? 'opacity-0 w-0' : 'opacity-100'}">{t(item.tKey)}</span>
			</a>
		{/each}
	</nav>

	<!-- Bottom items -->
	<div class="border-t border-white/10 px-2 py-2">
		<button
			onclick={() => theme.toggle()}
			aria-label={theme.value === 'dark' ? t('sidebar.lightMode') : t('sidebar.darkMode')}
			title={collapsed ? (theme.value === 'dark' ? t('sidebar.lightMode') : t('sidebar.darkMode')) : ''}
			class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
		>
			{#if theme.value === 'dark'}
				<svg class="h-5 w-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" /></svg>
				<span class="whitespace-nowrap overflow-hidden transition-opacity duration-200 {collapsed ? 'opacity-0 w-0' : 'opacity-100'}">{t('sidebar.lightMode')}</span>
			{:else}
				<svg class="h-5 w-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" /></svg>
				<span class="whitespace-nowrap overflow-hidden transition-opacity duration-200 {collapsed ? 'opacity-0 w-0' : 'opacity-100'}">{t('sidebar.darkMode')}</span>
			{/if}
		</button>
		<form method="POST" action="/logout" use:enhance>
			<button
				type="submit"
				title={collapsed ? t('sidebar.logout') : ''}
				aria-label={t('sidebar.logout')}
				class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
			>
				<svg class="h-5 w-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
				</svg>
				<span class="whitespace-nowrap overflow-hidden transition-opacity duration-200 {collapsed ? 'opacity-0 w-0' : 'opacity-100'}">{t('sidebar.logout')}</span>
			</button>
		</form>

	</div>
</aside>
