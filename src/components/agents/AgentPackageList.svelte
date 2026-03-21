<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { t } from '$lib/i18n/index.svelte.js';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import type { AgentPackage } from '$lib/types.js';

	interface Props {
		agentId: string;
		packages: AgentPackage[];
		disabled?: boolean;
		oncommand?: () => void;
	}

	let { agentId, packages, disabled = false, oncommand }: Props = $props();

	let filter = $state('');
	let selectedManager = $state<string | null>(null);
	let showUpdatesOnly = $state(false);
	let uninstallTarget = $state<AgentPackage | null>(null);

	// Group by manager for summary
	const managerGroups = $derived.by(() => {
		const groups = new Map<string, { total: number; updatable: number }>();
		for (const pkg of packages) {
			const g = groups.get(pkg.manager) || { total: 0, updatable: 0 };
			g.total++;
			if (pkg.updateAvailable) g.updatable++;
			groups.set(pkg.manager, g);
		}
		return groups;
	});

	const filtered = $derived.by(() => {
		let list = packages;
		if (selectedManager) list = list.filter(p => p.manager === selectedManager);
		if (showUpdatesOnly) list = list.filter(p => p.updateAvailable);
		if (filter) {
			const q = filter.toLowerCase();
			list = list.filter(p => p.name.toLowerCase().includes(q));
		}
		return list;
	});

	const totalPackages = $derived(packages.length);
	const updateCount = $derived(packages.filter(p => p.updateAvailable).length);

	async function sendCommand(type: string, payload: Record<string, unknown>) {
		try {
			const res = await fetch(`/api/agents/${agentId}/commands`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type, payload })
			});
			if (res.ok) {
				invalidateAll();
				return true;
			}
			const text = await res.text();
			try { toast(JSON.parse(text).message || text, 'error'); } catch { toast(text, 'error'); }
			return false;
		} catch (e) {
			toast(String(e), 'error');
			return false;
		}
	}

	async function updatePackage(pkg: AgentPackage) {
		if (await sendCommand('package_update', { manager: pkg.manager, package: pkg.name }))
			toast(t('agents.updateQueued', { name: pkg.name }), 'info');
	}

	async function confirmUninstall() {
		if (!uninstallTarget) return;
		const pkg = uninstallTarget;
		uninstallTarget = null;
		if (await sendCommand('package_uninstall', { manager: pkg.manager, package: pkg.name })) {
			toast(t('agents.uninstallQueued', { name: pkg.name }), 'info');
			oncommand?.();
		}
	}

	async function upgradeAll(manager: string) {
		if (await sendCommand('package_upgrade', { manager }))
			toast(t('agents.upgradeAllQueued', { manager }), 'info');
	}

	let osUpdateConfirm = $state(false);

	async function updateAllSoftware() {
		if (await sendCommand('software_update', {})) {
			toast(t('agents.softwareUpdateQueued'), 'info');
			oncommand?.();
		}
	}

	async function checkOsUpdates() {
		if (await sendCommand('check_os_updates', {})) {
			toast(t('agents.checkOsUpdatesQueued'), 'info');
			oncommand?.();
		}
	}

	async function applyOsUpdate() {
		osUpdateConfirm = false;
		if (await sendCommand('os_update', {})) {
			toast(t('agents.osUpdateQueued'), 'info');
			oncommand?.();
		}
	}
</script>

<div class="space-y-4">
	<!-- Summary row -->
	{#if totalPackages > 0}
		<div class="flex flex-wrap gap-2">
			<button
				onclick={() => { selectedManager = null; showUpdatesOnly = false; }}
				class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors
					{!selectedManager && !showUpdatesOnly ? 'bg-cyan text-white' : 'bg-near-black/5 text-near-black/60 hover:text-near-black'}"
			>
				All ({totalPackages})
			</button>
			{#each [...managerGroups] as [mgr, info]}
				<button
					onclick={() => { selectedManager = selectedManager === mgr ? null : mgr; showUpdatesOnly = false; }}
					class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors
						{selectedManager === mgr ? 'bg-cyan text-white' : 'bg-near-black/5 text-near-black/60 hover:text-near-black'}"
				>
					{mgr} ({info.total})
					{#if info.updatable > 0}
						<span class="ml-1 rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300 px-1.5">{info.updatable}</span>
					{/if}
				</button>
			{/each}
			{#if updateCount > 0}
				<button
					onclick={() => { showUpdatesOnly = !showUpdatesOnly; selectedManager = null; }}
					class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors
						{showUpdatesOnly ? 'bg-amber-500 text-white' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'}"
				>
					{updateCount} updates
				</button>
			{/if}
		</div>

		<!-- Search + bulk actions -->
		<div class="flex items-center gap-3">
			<div class="flex-1">
				<SearchInput bind:value={filter} />
			</div>
			{#if showUpdatesOnly || (selectedManager && (managerGroups.get(selectedManager)?.updatable ?? 0) > 0)}
				{@const mgr = selectedManager || (showUpdatesOnly ? [...managerGroups.keys()][0] : null)}
				{#if mgr}
					<Button size="sm" onclick={() => upgradeAll(mgr)} {disabled}>
						{t('agents.updateAll')} ({mgr})
					</Button>
				{/if}
			{/if}
		</div>

		<!-- Global update actions -->
		<div class="flex items-center gap-2">
			{#if updateCount > 0}
				<Button size="sm" variant="primary" onclick={updateAllSoftware} {disabled}>
					{t('agents.updateAllSoftware')}
				</Button>
			{/if}
			<Button size="sm" variant="secondary" onclick={checkOsUpdates} {disabled}>
				{t('agents.checkOsUpdates')}
			</Button>
			<Button size="sm" variant="danger" onclick={() => osUpdateConfirm = true} {disabled}>
				{t('agents.updateOs')}
			</Button>
		</div>

		<!-- Package list -->
		{#if filtered.length > 0}
			<div class="overflow-x-auto rounded-lg border border-border">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border bg-bg-card">
							<th class="px-3 py-2 text-left text-xs font-medium text-near-black/60">{t('agents.packageName')}</th>
							<th class="px-3 py-2 text-left text-xs font-medium text-near-black/60">{t('agents.packageVersion')}</th>
							<th class="px-3 py-2 text-left text-xs font-medium text-near-black/60">Source</th>
							<th class="px-3 py-2 text-right text-xs font-medium text-near-black/60"></th>
						</tr>
					</thead>
					<tbody>
						{#each filtered as pkg (`${pkg.manager}-${pkg.name}`)}
							<tr class="border-b border-border last:border-0 hover:bg-near-black/[0.02]">
								<td class="px-3 py-2">
									<div class="font-medium text-near-black">{pkg.name}</div>
								</td>
								<td class="px-3 py-2 font-mono text-xs">
									{#if pkg.updateAvailable}
										<span class="text-near-black/40 line-through">{pkg.version}</span>
										<span class="text-amber-600 dark:text-amber-400 font-semibold ml-1">{pkg.latestVersion}</span>
									{:else}
										<span class="text-near-black">{pkg.version || '—'}</span>
									{/if}
								</td>
								<td class="px-3 py-2">
									<span class="rounded bg-near-black/5 px-1.5 py-0.5 text-[10px] font-medium text-near-black/60">{pkg.manager}</span>
								</td>
								<td class="px-3 py-2 text-right whitespace-nowrap">
									<div class="flex items-center justify-end gap-1">
										{#if pkg.updateAvailable}
											<button onclick={() => updatePackage(pkg)} {disabled} title={t('agents.updatePackage')}
												class="rounded p-1 hover:bg-near-black/5 text-cyan disabled:opacity-50">
												<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
													<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
												</svg>
											</button>
										{/if}
										<button onclick={() => uninstallTarget = pkg} {disabled} title={t('action.delete')}
											class="rounded p-1 hover:bg-red-500/10 text-near-black/30 hover:text-red-500 disabled:opacity-50">
											<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
												<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
											</svg>
										</button>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="text-xs text-near-black/40 text-right">{filtered.length} packages</p>
		{:else}
			<p class="text-sm text-near-black/60 text-center py-8">
				{showUpdatesOnly ? t('agents.noUpdates') : t('agents.noPackages')}
			</p>
		{/if}
	{:else}
		<p class="text-sm text-near-black/60 text-center py-8">{t('agents.noPackages')}</p>
	{/if}
</div>

<ConfirmDialog
	open={!!uninstallTarget}
	title={t('action.delete')}
	message={uninstallTarget ? `Uninstall "${uninstallTarget.name}" (${uninstallTarget.manager})?` : ''}
	confirmLabel={t('action.delete')}
	variant="danger"
	onconfirm={confirmUninstall}
	oncancel={() => uninstallTarget = null}
/>

<ConfirmDialog
	open={osUpdateConfirm}
	title={t('agents.updateOs')}
	message={t('agents.osUpdateWarning')}
	confirmLabel={t('agents.updateOs')}
	variant="danger"
	onconfirm={applyOsUpdate}
	oncancel={() => osUpdateConfirm = false}
/>
