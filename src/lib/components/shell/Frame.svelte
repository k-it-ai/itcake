<script lang="ts">
	import type { Snippet } from 'svelte';
	import Sidebar from './Sidebar.svelte';
	import TopBar from './TopBar.svelte';
	import CommandPalette from './CommandPalette.svelte';
	import { palette } from '$lib/stores/palette.svelte.js';

	interface Props {
		title: string;
		breadcrumb?: string[];
		sub?: string;
		userName?: string;
		userEmail?: string;
		userRole?: string;
		right?: Snippet;
		children: Snippet;
	}

	const {
		title,
		breadcrumb,
		sub,
		userName,
		userEmail,
		userRole,
		right,
		children
	}: Props = $props();

	function handleHotkey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			palette.toggle();
		} else if (e.key === 'Escape' && palette.open) {
			e.preventDefault();
			palette.close();
		}
	}
</script>

<svelte:window onkeydown={handleHotkey} />

<div class="flex h-screen w-full overflow-hidden" style="background: var(--bg);">
	<Sidebar {userName} {userEmail} {userRole} />
	<main class="flex min-w-0 flex-1 flex-col">
		<TopBar {title} {breadcrumb} {sub} {right} />
		<div class="flex-1 overflow-auto p-5">
			{@render children()}
		</div>
	</main>
</div>

<CommandPalette />
