<script lang="ts">
	import Modal from '#components/ui/Modal.svelte';
	import Input from '#components/ui/Input.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import { t } from '#lib/i18n/index.svelte.js';
	import { stepUpPrompt } from '#lib/step-up.svelte.js';

	let code = $state('');

	$effect(() => {
		if (!stepUpPrompt.open) code = '';
	});
</script>

<Modal
	open={stepUpPrompt.open}
	title={t('settings.mfaStepUpTitle')}
	onclose={() => stepUpPrompt.cancel()}
>
	{#snippet children()}
		<div class="space-y-3">
			<p class="text-sm text-ink/70">{stepUpPrompt.label}</p>
			<Input label={t('settings.mfaCodeOrRecovery')} bind:value={code} autocomplete="one-time-code" />
			{#if stepUpPrompt.error}
				<p class="text-sm text-bad">{stepUpPrompt.error}</p>
			{/if}
		</div>
	{/snippet}
	{#snippet actions()}
		<Btn variant="ghost" onclick={() => stepUpPrompt.cancel()}>{t('action.cancel')}</Btn>
		<Btn variant="primary" disabled={!code.trim()} onclick={() => stepUpPrompt.submit(code.trim())}>
			{t('action.confirm')}
		</Btn>
	{/snippet}
</Modal>
