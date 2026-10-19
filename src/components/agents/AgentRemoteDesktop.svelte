<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Toggle from '#lib/components/ui/Toggle.svelte';
	import Input from '#components/ui/Input.svelte';
	import Select from '#components/ui/Select.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { api, getErrorMessage } from '#lib/api.js';
	import { withStepUp } from '#lib/step-up.svelte.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { RemoteSession } from '#lib/types.js';

	let { agentId, agentEnabled }: { agentId: string; agentEnabled: boolean } = $props();

	type Profile = {
		protocol: 'rdp' | 'vnc' | 'ssh';
		host: string;
		port: number;
		username: string;
		domain?: string;
		ignoreCert?: boolean;
		recording?: boolean;
		hasPassword: boolean;
		hasPrivateKey: boolean;
	};

	let profile = $state<Profile | null>(null);
	let recordedSessions = $state<RemoteSession[]>([]);
	let loading = $state(false);
	let saving = $state(false);
	let opening = $state(false);
	let editing = $state({
		protocol: 'rdp' as 'rdp' | 'vnc' | 'ssh',
		host: '',
		port: 3389,
		username: '',
		password: '',
		domain: '',
		ignoreCert: true,
		recording: false,
		privateKey: ''
	});

	async function load() {
		loading = true;
		try {
			const r = await api.get<{ profile: Profile | null; sessions: RemoteSession[] }>(`/api/agents/${agentId}/remote-session`);
			profile = r.profile;
			recordedSessions = (r.sessions ?? []).filter(s => s.recordingPath);
			if (profile) {
				editing = {
					protocol: profile.protocol,
					host: profile.host || '',
					port: profile.port,
					username: profile.username || '',
					password: '',
					domain: profile.domain || '',
					ignoreCert: profile.ignoreCert ?? true,
					recording: profile.recording ?? false,
					privateKey: ''
				};
			}
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedLoad')), 'error');
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function sessionDuration(s: RemoteSession): string {
		if (!s.startedAt || !s.endedAt) return '—';
		const ms = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '—';
		const sec = Math.round(ms / 1000);
		const m = Math.floor(sec / 60);
		const s2 = sec % 60;
		return `${m}m ${s2.toString().padStart(2, '0')}s`;
	}

	function defaultPort(p: 'rdp' | 'vnc' | 'ssh'): number {
		return p === 'rdp' ? 3389 : p === 'vnc' ? 5900 : 22;
	}

	$effect(() => {
		if (editing.port === defaultPort(profile?.protocol ?? 'rdp')) {
			editing.port = defaultPort(editing.protocol);
		}
	});

	async function save() {
		saving = true;
		try {
			const payload: Record<string, unknown> = {
				protocol: editing.protocol,
				host: editing.host,
				port: editing.port,
				username: editing.username,
				ignoreCert: editing.ignoreCert,
				recording: editing.recording
			};
			if (editing.password) payload.password = editing.password;
			if (editing.protocol === 'rdp' && editing.domain) payload.domain = editing.domain;
			if (editing.protocol === 'ssh' && editing.privateKey) payload.privateKey = editing.privateKey;

			await withStepUp(extra => api.post(`/api/agents/${agentId}/remote-session`, { action: 'set-profile', profile: payload, ...extra }));
			editing.password = '';
			editing.privateKey = '';
			await load();
			toast(t('rd.profileSaved'), 'success');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedSave')), 'error');
		} finally {
			saving = false;
		}
	}

	async function clear() {
		if (!confirm(t('rd.confirmClear'))) return;
		try {
			await withStepUp(extra => api.post(`/api/agents/${agentId}/remote-session`, { action: 'clear-profile', ...extra }));
			profile = null;
			editing = { protocol: 'rdp', host: '', port: 3389, username: '', password: '', domain: '', ignoreCert: true, recording: false, privateKey: '' };
			toast(t('rd.profileCleared'), 'success');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedSave')), 'error');
		}
	}

	async function openSession() {
		opening = true;
		try {
			const r = await withStepUp(extra => api.post<{ popupUrl: string; expiresAt: string }>(`/api/agents/${agentId}/remote-session`, { ...extra }));
			const win = window.open(r.popupUrl, '_blank', 'width=1280,height=800,noopener,noreferrer');
			if (!win) toast(t('rd.popupBlocked'), 'error');
		} catch (e) {
			toast(getErrorMessage(e, t('rd.openFailed')), 'error');
		} finally {
			opening = false;
		}
	}
</script>

<Card>
	<SectionHead title={t('rd.agentTitle')} sub={t('rd.agentHelp')}>
		{#snippet right()}
			{#if profile}
				<Btn variant="primary" size="sm" onclick={openSession} disabled={!agentEnabled}>{opening ? '…' : t('rd.openSession')}</Btn>
			{/if}
		{/snippet}
	</SectionHead>

	<div class="grid sm:grid-cols-2 gap-3">
		<Select label={t('rd.protocol')} bind:value={editing.protocol} options={[
			{ value: 'rdp', label: 'RDP (Windows)' },
			{ value: 'vnc', label: 'VNC' },
			{ value: 'ssh', label: 'SSH' }
		]} />
		<Input label={t('rd.host')} placeholder="10.0.0.5" bind:value={editing.host} />
		<Input type="number" label={t('rd.port')} bind:value={editing.port} />
		<Input label={t('rd.username')} bind:value={editing.username} />
		<Input type="password" label={t('rd.password')} placeholder={profile?.hasPassword ? t('rd.secretSet') : ''} bind:value={editing.password} />
		{#if editing.protocol === 'rdp'}
			<Input label={t('rd.domain')} bind:value={editing.domain} />
			<div class="flex items-center pt-6">
				<Toggle bind:checked={editing.ignoreCert} label={t('rd.ignoreCert')} />
			</div>
		{:else if editing.protocol === 'ssh'}
			<div class="sm:col-span-2">
				<label for="rd-private-key" class="block text-[12px] mb-1" style="color:var(--ink)">{t('rd.privateKey')}</label>
				<textarea
					id="rd-private-key"
					rows="4"
					class="w-full rounded-md border p-2 font-mono text-[11px] focus:outline-2 focus:outline-[var(--brand)] focus:outline-offset-1"
					style="background:var(--card);border-color:var(--line);color:var(--ink)"
					placeholder={profile?.hasPrivateKey ? t('rd.secretSet') : '-----BEGIN OPENSSH PRIVATE KEY-----'}
					bind:value={editing.privateKey}
				></textarea>
			</div>
		{/if}
		<div class="flex items-center pt-6 sm:col-span-2">
			<Toggle bind:checked={editing.recording} label={t('rd.recordingPerAgent')} />
		</div>
	</div>

	<div class="mt-4 flex flex-wrap gap-2">
		<Btn variant="primary" size="sm" onclick={save}>{saving ? '…' : t('action.save')}</Btn>
		{#if profile}
			<Btn variant="dangerSoft" size="sm" onclick={clear}>{t('rd.clearProfile')}</Btn>
		{/if}
	</div>

	<div class="pt-4 mt-4 space-y-2" style="border-top:1px solid var(--line-2)">
		<div>
			<h4 class="font-semibold text-[13px]" style="color:var(--ink)">{t('rd.recordings')}</h4>
			<p class="text-[11.5px] mt-1" style="color:var(--muted)">{t('rd.recordingsHelp')}</p>
		</div>
		{#if recordedSessions.length === 0}
			<p class="text-[12px]" style="color:var(--muted)">{t('rd.recordingsNone')}</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-[12px]">
					<thead>
						<tr style="border-bottom:1px solid var(--line-2)">
							<th class="text-left py-1 pr-3 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('rd.recordingStarted')}</th>
							<th class="text-left py-1 pr-3 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('rd.recordingProtocol')}</th>
							<th class="text-left py-1 pr-3 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('rd.recordingDuration')}</th>
							<th class="text-left py-1 pr-3 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)"></th>
						</tr>
					</thead>
					<tbody>
						{#each recordedSessions as s (s.id)}
							<tr style="border-top:1px solid var(--line-2)">
								<td class="py-1.5 pr-3 num" style="color:var(--ink)">{new Date(s.startedAt ?? s.createdAt).toLocaleString()}</td>
								<td class="py-1.5 pr-3 uppercase" style="color:var(--ink)">{s.protocol}</td>
								<td class="py-1.5 pr-3 num" style="color:var(--ink)">{sessionDuration(s)}</td>
								<td class="py-1.5 pr-3">
									<a
										class="underline-offset-2 hover:underline"
										style="color:var(--brand-ink)"
										href={`/api/remote-desktop/recording/${s.id}`}
										download={`recording-${s.id}.mp4`}
									>{t('rd.recordingPlay')}</a>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</Card>
