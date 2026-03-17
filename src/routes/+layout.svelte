<script lang="ts">
	import '../app.css';
	import Toast from '$components/ui/Toast.svelte';
	import { theme } from '$lib/stores/theme.svelte.js';
	import { i18n } from '$lib/i18n/index.svelte.js';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	// Apply theme on mount
	if (browser) {
		document.documentElement.setAttribute('data-theme', theme.value);
	}

	// Sync interface language from settings (immediate set for SSR + reactive effect for client)
	i18n.lang = page.data?.settings?.general?.language || page.data?.interfaceLang || 'en';
	$effect(() => {
		const lang = page.data?.settings?.general?.language || page.data?.interfaceLang || 'en';
		i18n.lang = lang;
		// Sync <html lang> so screen readers and browser auto-translation detect the correct language
		if (browser) {
			document.documentElement.lang = lang;
		}
	});
</script>

{@render children()}
<Toast />
