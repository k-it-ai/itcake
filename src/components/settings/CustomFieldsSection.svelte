<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import Button from '$components/ui/Button.svelte';
	import Modal from '$components/ui/Modal.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { t } from '$lib/i18n/index.svelte.js';

	type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'enum';
	type AppliesTo = 'invoice' | 'proposal' | 'client' | 'ticket' | 'expense' | 'agent';

	interface CustomFieldDef {
		id: string;
		name: string;
		fieldKey: string;
		type: FieldType;
		enumValues?: string[];
		appliesTo: AppliesTo[];
		required?: boolean;
	}

	const APPLIES: AppliesTo[] = ['invoice', 'proposal', 'client', 'ticket', 'expense', 'agent'];
	const TYPES: FieldType[] = ['text', 'number', 'boolean', 'date', 'enum'];

	let fields = $state<CustomFieldDef[]>([]);
	let loading = $state(false);
	let editorOpen = $state(false);
	let editing = $state<Partial<CustomFieldDef> & { enumValuesText?: string }>({});
	let saving = $state(false);

	async function load() {
		loading = true;
		try {
			fields = await api.get<CustomFieldDef[]>('/api/custom-fields');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedLoad')), 'error');
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function openNew() {
		editing = { name: '', fieldKey: '', type: 'text', appliesTo: ['agent'], required: false, enumValuesText: '' };
		editorOpen = true;
	}

	function openEdit(f: CustomFieldDef) {
		editing = { ...f, enumValuesText: (f.enumValues ?? []).join('\n') };
		editorOpen = true;
	}

	function suggestKey() {
		if (!editing.name) return;
		if (editing.id) return; // immutable post-create
		const k = editing.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32);
		editing.fieldKey = k;
	}

	async function save() {
		saving = true;
		try {
			const enumValues = editing.type === 'enum'
				? (editing.enumValuesText ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
				: undefined;
			const payload = {
				name: editing.name,
				fieldKey: editing.fieldKey,
				type: editing.type,
				enumValues,
				appliesTo: editing.appliesTo ?? [],
				required: editing.required ?? false
			};
			if (editing.id) {
				await api.post('/api/custom-fields', { action: 'update', id: editing.id, ...payload });
			} else {
				await api.post('/api/custom-fields', payload);
			}
			editorOpen = false;
			await load();
			toast(t('customField.saved'), 'success');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedSave')), 'error');
		} finally {
			saving = false;
		}
	}

	async function del(f: CustomFieldDef) {
		if (!confirm(t('customField.confirmDelete'))) return;
		try {
			await api.post('/api/custom-fields', { action: 'delete', id: f.id });
			await load();
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedDelete')), 'error');
		}
	}

	function toggleApplies(a: AppliesTo) {
		const cur = editing.appliesTo ?? [];
		editing.appliesTo = cur.includes(a) ? cur.filter(x => x !== a) : [...cur, a];
	}
</script>

<div class="space-y-4">
	<Card class="space-y-3">
		<div class="flex items-center justify-between">
			<div>
				<h3 class="text-lg font-semibold">{t('customField.title')}</h3>
				<p class="text-xs text-near-black/60 mt-1">{t('customField.help')}</p>
			</div>
			<Button onclick={openNew}>{t('customField.new')}</Button>
		</div>

		{#if fields.length === 0}
			<EmptyState title={t('customField.empty')} description={t('customField.emptyHelp')} />
		{:else}
			<div class="space-y-2">
				{#each fields as f (f.id)}
					<div class="flex items-center gap-3 p-3 rounded border border-border bg-bg-card">
						<div class="flex-1 min-w-0">
							<div class="font-medium truncate">{f.name} <span class="text-xs font-mono text-near-black/40">custom.{f.fieldKey}</span></div>
							<div class="text-xs text-near-black/60">
								{f.type}{#if f.type === 'enum' && f.enumValues}
									<span> ({f.enumValues.length} values)</span>
								{/if}
								· {f.appliesTo.join(', ')}{#if f.required} · required{/if}
							</div>
						</div>
						<Button size="sm" variant="secondary" onclick={() => openEdit(f)}>{t('action.edit')}</Button>
						<Button size="sm" variant="danger" onclick={() => del(f)}>{t('action.delete')}</Button>
					</div>
				{/each}
			</div>
		{/if}
	</Card>
</div>

<Modal bind:open={editorOpen} onclose={() => (editorOpen = false)} title={editing.id ? t('customField.edit') : t('customField.new')}>
	<div class="space-y-3">
		<Input label={t('customField.name')} bind:value={editing.name as string} onblur={suggestKey} />
		<Input label={t('customField.fieldKey')} bind:value={editing.fieldKey as string} disabled={!!editing.id} />
		<Select label={t('customField.type')} bind:value={editing.type as string} options={TYPES.map(x => ({ value: x, label: x }))} />

		{#if editing.type === 'enum'}
			<label class="block">
				<span class="block text-sm font-medium mb-1">{t('customField.enumValues')}</span>
				<textarea
					class="w-full rounded border border-border bg-input-bg text-sm text-near-black px-3 py-2 focus:border-cyan focus:outline-none"
					rows="4"
					placeholder={t('customField.enumValuesPlaceholder')}
					bind:value={editing.enumValuesText as string}
				></textarea>
			</label>
		{/if}

		<div>
			<span class="block text-sm font-medium mb-1">{t('customField.appliesTo')}</span>
			<div class="flex flex-wrap gap-2">
				{#each APPLIES as a}
					<label class="flex items-center gap-2 px-2 py-1 border border-border rounded">
						<input type="checkbox" checked={editing.appliesTo?.includes(a)} onchange={() => toggleApplies(a)} />
						<span class="text-sm">{a}</span>
					</label>
				{/each}
			</div>
		</div>

		<label class="flex items-center gap-2">
			<input type="checkbox" bind:checked={editing.required as boolean} />
			<span class="text-sm">{t('customField.required')}</span>
		</label>

		<div class="flex justify-end gap-2 pt-2">
			<Button variant="secondary" onclick={() => (editorOpen = false)}>{t('action.cancel')}</Button>
			<Button onclick={save} loading={saving} disabled={!editing.name || !editing.fieldKey || (editing.appliesTo?.length ?? 0) === 0}>{t('action.save')}</Button>
		</div>
	</div>
</Modal>
