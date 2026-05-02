<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import Button from '$components/ui/Button.svelte';
	import Toggle from '$components/ui/Toggle.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { RemoteSession } from '$lib/types.js';

	let { agentId, agentEnabled }: { agentId: string; agentEnabled: boolean } = $props();

	type Profile = {
		protocol: 'rdp' | 'vnc' | 'ssh';
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
				port: editing.port,
				username: editing.username,
				ignoreCert: editing.ignoreCert,
				recording: editing.recording
			};
			if (editing.password) payload.password = editing.password;
			if (editing.protocol === 'rdp' && editing.domain) payload.domain = editing.domain;
			if (editing.protocol === 'ssh' && editing.privateKey) payload.privateKey = editing.privateKey;

			await api.post(`/api/agents/${agentId}/remote-session`, { action: 'set-profile', profile: payload });
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
			await api.post(`/api/agents/${agentId}/remote-session`, { action: 'clear-profile' });
			profile = null;
			editing = { protocol: 'rdp', port: 3389, username: '', password: '', domain: '', ignoreCert: true, recording: false, privateKey: '' };
			toast(t('rd.profileCleared'), 'success');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedSave')), 'error');
		}
	}

	async function openSession() {
		opening = true;
		try {
			const r = await api.post<{ popupUrl: string; expiresAt: string }>(`/api/agents/${agentId}/remote-session`, {});
			const win = window.open(r.popupUrl, '_blank', 'width=1280,height=800,noopener,noreferrer');
			if (!win) toast(t('rd.popupBlocked'), 'error');
		} catch (e) {
			toast(getErrorMessage(e, t('rd.openFailed')), 'error');
		} finally {
			opening = false;
		}
	}
</script>

<Card class="space-y-4">
	<div class="flex items-start justify-between gap-4">
		<div>
			<h3 class="text-lg font-semibold">{t('rd.agentTitle')}</h3>
			<p class="text-xs text-near-black/60 mt-1">{t('rd.agentHelp')}</p>
		</div>
		{#if profile}
			<Button onclick={openSession} loading={opening} disabled={!agentEnabled}>{t('rd.openSession')}</Button>
		{/if}
	</div>

	<div class="grid sm:grid-cols-2 gap-3">
		<Select label={t('rd.protocol')} bind:value={editing.protocol} options={[
			{ value: 'rdp', label: 'RDP (Windows)' },
			{ value: 'vnc', label: 'VNC' },
			{ value: 'ssh', label: 'SSH' }
		]} />
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
				<label for="rd-private-key" class="block text-sm mb-1">{t('rd.privateKey')}</label>
				<textarea
					id="rd-private-key"
					rows="4"
					class="w-full rounded border border-border bg-input-bg p-2 font-mono text-xs"
					placeholder={profile?.hasPrivateKey ? t('rd.secretSet') : '-----BEGIN OPENSSH PRIVATE KEY-----'}
					bind:value={editing.privateKey}
				></textarea>
			</div>
		{/if}
		<div class="flex items-center pt-6 sm:col-span-2">
			<Toggle bind:checked={editing.recording} label={t('rd.recordingPerAgent')} />
		</div>
	</div>

	<div class="flex flex-wrap gap-2">
		<Button onclick={save} loading={saving}>{t('action.save')}</Button>
		{#if profile}
			<Button variant="danger" onclick={clear}>{t('rd.clearProfile')}</Button>
		{/if}
	</div>

	<div class="border-t border-border pt-4 space-y-2">
		<div>
			<h4 class="font-semibold text-sm">{t('rd.recordings')}</h4>
			<p class="text-xs text-near-black/60 mt-1">{t('rd.recordingsHelp')}</p>
		</div>
		{#if recordedSessions.length === 0}
			<p class="text-sm text-near-black/60">{t('rd.recordingsNone')}</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs text-near-black/60">
						<tr>
							<th class="py-1 pr-3">{t('rd.recordingStarted')}</th>
							<th class="py-1 pr-3">{t('rd.recordingProtocol')}</th>
							<th class="py-1 pr-3">{t('rd.recordingDuration')}</th>
							<th class="py-1 pr-3"></th>
						</tr>
					</thead>
					<tbody>
						{#each recordedSessions as s (s.id)}
							<tr class="border-t border-border">
								<td class="py-1 pr-3">{new Date(s.startedAt ?? s.createdAt).toLocaleString()}</td>
								<td class="py-1 pr-3 uppercase">{s.protocol}</td>
								<td class="py-1 pr-3">{sessionDuration(s)}</td>
								<td class="py-1 pr-3">
									<a
										class="underline text-accent"
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
