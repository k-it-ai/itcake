<script lang="ts">
	import Button from '$components/ui/Button.svelte';
	import Input from '$components/ui/Input.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { getErrorMessage } from '$lib/api.js';
	import { t } from '$lib/i18n/index.svelte.js';

	let { agentId, tags: initialTags }: { agentId: string; tags: string[] } = $props();

	let tags = $state([...initialTags]);
	let pending = $state('');
	let saving = $state(false);

	function addTag() {
		const v = pending.toLowerCase().trim();
		if (!v) return;
		if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(v)) {
			toast(t('agents.tagFormat'), 'error');
			return;
		}
		if (tags.includes(v)) { pending = ''; return; }
		tags = [...tags, v];
		pending = '';
	}

	function removeTag(tag: string) {
		tags = tags.filter(t => t !== tag);
	}

	async function save() {
		saving = true;
		try {
			const res = await fetch(`/api/agents/${agentId}/tags`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tags })
			});
			if (!res.ok) throw new Error(await res.text());
			toast(t('agents.tagsSaved'), 'success');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedSave')), 'error');
		} finally {
			saving = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') { e.preventDefault(); addTag(); }
		else if (e.key === 'Backspace' && pending === '' && tags.length > 0) {
			tags = tags.slice(0, -1);
		}
	}

	const dirty = $derived(JSON.stringify([...tags].sort()) !== JSON.stringify([...initialTags].sort()));
</script>

<div class="space-y-2">
	<div class="flex flex-wrap items-center gap-2 p-2 rounded border border-border bg-input-bg min-h-[2.5rem]">
		{#each tags as tag (tag)}
			<Badge variant="default">
				<span class="font-mono">{tag}</span>
				<button class="ml-1 hover:text-red-500" aria-label={t('action.remove')} onclick={() => removeTag(tag)}>×</button>
			</Badge>
		{/each}
		<input
			type="text"
			placeholder={t('agents.tagPlaceholder')}
			class="flex-1 min-w-[8rem] bg-transparent outline-none text-sm"
			bind:value={pending}
			onkeydown={onKeydown}
		/>
	</div>
	{#if dirty}
		<div class="flex justify-end">
			<Button size="sm" loading={saving} onclick={save}>{t('action.save')}</Button>
		</div>
	{/if}
</div>
