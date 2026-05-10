<script lang="ts">
	import Btn from '$lib/components/ui/Btn.svelte';
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
	<div
		class="flex flex-wrap items-center gap-2 p-2 rounded-md border min-h-[2.5rem]"
		style="background:var(--card);border-color:var(--line)"
	>
		{#each tags as tag (tag)}
			<span
				class="inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[11px] font-medium num"
				style="background:#eef0f4;color:#3a424c"
			>
				<span class="font-mono">{tag}</span>
				<button
					class="transition-opacity hover:opacity-100"
					style="opacity:.4"
					aria-label={t('action.remove')}
					onclick={() => removeTag(tag)}
				>×</button>
			</span>
		{/each}
		<input
			type="text"
			placeholder={t('agents.tagPlaceholder')}
			class="flex-1 min-w-[8rem] bg-transparent outline-none text-[12px]"
			style="color:var(--ink)"
			bind:value={pending}
			onkeydown={onKeydown}
		/>
	</div>
	{#if dirty}
		<div class="flex justify-end">
			<Btn variant="primary" size="sm" onclick={save}>{saving ? '…' : t('action.save')}</Btn>
		</div>
	{/if}
</div>
