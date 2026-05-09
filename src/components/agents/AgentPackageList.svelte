<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { t } from '$lib/i18n/index.svelte.js';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import Btn from '$lib/components/ui/Btn.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import Tag from '$lib/components/ui/Tag.svelte';
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
	{#if totalPackages > 0}
		<!-- Manager filter chips -->
		<div class="flex flex-wrap gap-1.5">
			<button
				type="button"
				onclick={() => { selectedManager = null; showUpdatesOnly = false; }}
				aria-pressed={!selectedManager && !showUpdatesOnly}
				class="rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1"
				style={!selectedManager && !showUpdatesOnly
					? 'background:var(--brand-soft);border-color:#c8e2ec;color:var(--brand-ink)'
					: 'background:var(--card);border-color:var(--line);color:var(--muted)'}
			>
				All ({totalPackages})
			</button>
			{#each [...managerGroups] as [mgr, info]}
				<button
					type="button"
					onclick={() => { selectedManager = selectedManager === mgr ? null : mgr; showUpdatesOnly = false; }}
					aria-pressed={selectedManager === mgr}
					class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1"
					style={selectedManager === mgr
						? 'background:var(--brand-soft);border-color:#c8e2ec;color:var(--brand-ink)'
						: 'background:var(--card);border-color:var(--line);color:var(--muted)'}
				>
					<span>{mgr} ({info.total})</span>
					{#if info.updatable > 0}
						<Tag tone="warn">{info.updatable}</Tag>
					{/if}
				</button>
			{/each}
			{#if updateCount > 0}
				<button
					type="button"
					onclick={() => { showUpdatesOnly = !showUpdatesOnly; selectedManager = null; }}
					aria-pressed={showUpdatesOnly}
					class="rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1"
					style={showUpdatesOnly
						? 'background:var(--warn-soft);border-color:#f0d8a0;color:#7a4400'
						: 'background:var(--warn-soft);border-color:#f0d8a0;color:#7a4400'}
				>
					{updateCount} updates
				</button>
			{/if}
		</div>

		<!-- Search + bulk actions row -->
		<div class="flex items-center gap-3">
			<div class="flex-1">
				<SearchInput bind:value={filter} />
			</div>
			{#if showUpdatesOnly || (selectedManager && (managerGroups.get(selectedManager)?.updatable ?? 0) > 0)}
				{@const mgr = selectedManager || (showUpdatesOnly ? [...managerGroups.keys()][0] : null)}
				{#if mgr}
					<Btn variant="primary" size="sm" onclick={() => upgradeAll(mgr)} {disabled}>
						{t('agents.updateAll')} ({mgr})
					</Btn>
				{/if}
			{/if}
		</div>

		<!-- Global update actions -->
		<div class="flex items-center gap-2 flex-wrap">
			{#if updateCount > 0}
				<Btn variant="primary" size="sm" onclick={updateAllSoftware} {disabled}>
					{t('agents.updateAllSoftware')}
				</Btn>
			{/if}
			<Btn variant="soft" size="sm" onclick={checkOsUpdates} {disabled}>
				{t('agents.checkOsUpdates')}
			</Btn>
			<Btn variant="dangerSoft" size="sm" onclick={() => osUpdateConfirm = true} {disabled}>
				{t('agents.updateOs')}
			</Btn>
		</div>

		<!-- Package list -->
		{#if filtered.length > 0}
			<Card padding={0}>
				<table class="w-full text-[12px]">
					<thead style="background:#fbfcfd;border-bottom:1px solid var(--line-2)">
						<tr>
							<th class="px-4 py-2 text-left text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.packageName')}</th>
							<th class="px-3 py-2 text-left text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.packageVersion')}</th>
							<th class="px-3 py-2 text-left text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">Source</th>
							<th class="px-4 py-2 text-right text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)"></th>
						</tr>
					</thead>
					<tbody>
						{#each filtered as pkg (`${pkg.manager}-${pkg.name}`)}
							<tr style="border-top:1px solid var(--line-2)">
								<td class="px-4 py-2">
									<div class="font-medium" style="color:var(--ink)">{pkg.name}</div>
								</td>
								<td class="px-3 py-2 font-mono text-[11px] num">
									{#if pkg.updateAvailable}
										<span class="line-through" style="color:var(--muted)">{pkg.version}</span>
										<span class="font-semibold ml-1" style="color:var(--warn)">{pkg.latestVersion}</span>
									{:else}
										<span style="color:var(--ink)">{pkg.version || '—'}</span>
									{/if}
								</td>
								<td class="px-3 py-2">
									<Tag tone="neutral">{pkg.manager}</Tag>
								</td>
								<td class="px-4 py-2 text-right whitespace-nowrap">
									<div class="flex items-center justify-end gap-1">
										{#if pkg.updateAvailable}
											<button onclick={() => updatePackage(pkg)} {disabled} title={t('agents.updatePackage')}
												class="rounded-md p-1 transition-colors hover:bg-[var(--brand-soft)] disabled:opacity-50" style="color:var(--brand)">
												<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.6">
													<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
												</svg>
											</button>
										{/if}
										<button onclick={() => uninstallTarget = pkg} {disabled} title={t('action.delete')}
											class="rounded-md p-1 transition-colors hover:bg-[var(--bad-soft)] disabled:opacity-50" style="color:var(--muted)">
											<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.6">
												<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
											</svg>
										</button>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</Card>
			<p class="text-[11px] text-right" style="color:var(--muted)">{filtered.length} packages</p>
		{:else}
			<p class="text-[12px] text-center py-8" style="color:var(--muted)">
				{showUpdatesOnly ? t('agents.noUpdates') : t('agents.noPackages')}
			</p>
		{/if}
	{:else}
		<p class="text-[12px] text-center py-8" style="color:var(--muted)">{t('agents.noPackages')}</p>
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
