<script lang="ts">
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import ErrorState from '#lib/components/ui/ErrorState.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import { t } from '#lib/i18n/index.svelte.js';

	const status = $derived(page.status);
	const code = $derived(`${status}`);
</script>

<svelte:head><title>{status} | ITCake</title></svelte:head>

<div class="flex h-full items-center justify-center px-8 py-12">
	<div class="w-full max-w-md">
		<ErrorState
			title={t('errorPage.title')}
			message={`${t('errorPage.body')} (${code})`}
			retry={() => invalidateAll()}
			retryLabel={t('errorPage.retry')}
		>
			{#snippet actions()}
				<Btn variant="ghost" size="sm" href="/dashboard">{t('errorPage.openDashboard') ?? 'Dashboard'}</Btn>
				<Btn variant="ghost" size="sm" href="/changes">{t('errorPage.openAudit')}</Btn>
			{/snippet}
		</ErrorState>
	</div>
</div>
