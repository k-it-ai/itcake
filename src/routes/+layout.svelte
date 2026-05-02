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

	if (browser) {
		document.documentElement.setAttribute('data-theme', theme.value);
	}

	i18n.lang = page.data?.settings?.general?.language || page.data?.interfaceLang || 'en';
	$effect(() => {
		const lang = page.data?.settings?.general?.language || page.data?.interfaceLang || 'en';
		i18n.lang = lang;
		if (browser) {
			document.documentElement.lang = lang;
		}
	});
</script>

{@render children()}
<Toast />
