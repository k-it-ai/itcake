<script lang="ts">
	import Btn from '#lib/components/ui/Btn.svelte';
	import Input from '#components/ui/Input.svelte';
	import Modal from '#components/ui/Modal.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { api, getErrorMessage } from '#lib/api.js';
	import { t } from '#lib/i18n/index.svelte.js';

	let { agentId, disabled = false }: { agentId: string; disabled?: boolean } = $props();

	let open = $state(false);
	let delaySeconds = $state(60);
	let message = $state('ITCake RMM scheduled reboot');
	let dispatching = $state(false);

	async function dispatch() {
		dispatching = true;
		try {
			await api.post(`/api/agents/${agentId}/commands`, {
				type: 'reboot',
				payload: { delaySeconds, message },
				timeoutSeconds: 60
			});
			toast(t('agents.rebootDispatched'), 'success');
			open = false;
		} catch (e) {
			toast(getErrorMessage(e, t('agents.rebootFailed')), 'error');
		} finally {
			dispatching = false;
		}
	}
</script>

<Btn variant="warnSoft" size="sm" {disabled} onclick={() => (open = true)}>
	{t('agents.reboot')}
</Btn>

<Modal bind:open onclose={() => (open = false)} title={t('agents.rebootTitle')}>
	<div class="space-y-3">
		<p class="text-[12px]" style="color:var(--muted)">{t('agents.rebootHelp')}</p>
		<Input type="number" label={t('agents.rebootDelay')} bind:value={delaySeconds} min={0} max={86400} />
		<Input label={t('agents.rebootMessage')} bind:value={message} maxlength={200} />
		<div class="flex justify-end gap-2 pt-2">
			<Btn variant="ghost" onclick={() => (open = false)}>{t('action.cancel')}</Btn>
			<Btn variant="danger" onclick={dispatch}>
				{dispatching ? '…' : t('agents.rebootConfirm')}
			</Btn>
		</div>
	</div>
</Modal>
