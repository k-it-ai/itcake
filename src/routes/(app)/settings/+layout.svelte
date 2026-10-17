<script lang="ts">
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import type { Snippet } from 'svelte';
	import { t } from '#lib/i18n/index.svelte.js';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<TopBar title={t('settings.title')} />

<div class="p-6">
	{@render children()}
</div>
