<script lang="ts">
	import { t } from '$lib/i18n/index.svelte.js';
	import Modal from '$components/ui/Modal.svelte';
	import Button from '$components/ui/Button.svelte';
	import { toast } from '$components/ui/Toast.svelte';

	interface Props {
		open: boolean;
		serverUrl?: string;
		onclose: () => void;
	}

	let { open = $bindable(), serverUrl = '', onclose }: Props = $props();

	let name = $state('');
	let generatedToken = $state<string | null>(null);
	let loading = $state(false);
	let copied = $state(false);
	let osChoice = $state<'unix' | 'windows'>('unix');
	let pinTLS = $state(true);

	async function generateToken() {
		loading = true;
		try {
			const res = await fetch('/api/agents/enrollment-tokens', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!res.ok) {
				toast(await res.text(), 'error');
				return;
			}
			const data = await res.json();
			generatedToken = data.token;
		} finally {
			loading = false;
		}
	}

	function base(): string {
		return serverUrl || (typeof window !== 'undefined' ? window.location.origin : '');
	}

	function unixCommand(): string {
		const pinFlag = pinTLS ? ' --pin-tls' : '';
		return `curl -fsSL ${base()}/api/rmm/download/$(uname -s | tr A-Z a-z)/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') -o /tmp/itcake-agent && chmod +x /tmp/itcake-agent && sudo cp /tmp/itcake-agent /usr/local/bin/itcake-agent && (sudo xattr -rd com.apple.quarantine /usr/local/bin/itcake-agent 2>/dev/null; codesign --sign - --force /usr/local/bin/itcake-agent 2>/dev/null; true) && sudo itcake-agent enroll --server ${base()} --token ${generatedToken}${pinFlag} && sudo itcake-agent service install && rm -f /tmp/itcake-agent`;
	}

	/** Windows PowerShell one-liner. Must be run in an elevated PowerShell prompt.
	 *
	 *  Notes on the shape of this command (for anyone editing it later):
	 *    - `-NoProfile -ExecutionPolicy Bypass` is scoped to THIS invocation
	 *      only. It does not permanently change machine policy — which is
	 *      what AV/Defender heuristics flag. -ExecutionPolicy Bypass here
	 *      is fine because we're not running a downloaded .ps1 file; we're
	 *      running an inline command (no AMSI bypass, no IEX on a webstring).
	 *    - We download the .exe and run its CLI — not a PowerShell payload —
	 *      so Defender's AMSI doesn't scan "script content", only the binary.
	 *      A code-signed release binary is the final step for quiet install.
	 *    - -arp normalization for arm64 devices (Windows on ARM). */
	function windowsCommand(): string {
		const pinFlag = pinTLS ? ' --pin-tls' : '';
		return `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $arch = if ([Environment]::Is64BitOperatingSystem) { if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' } } else { 'amd64' }; $dst = 'C:\\ProgramData\\ITCake\\itcake-agent.exe'; New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri ('${base()}/api/rmm/download/windows/' + $arch) -OutFile $dst; Unblock-File -Path $dst; & $dst enroll --server '${base()}' --token '${generatedToken}'${pinFlag}; & $dst service install"`;
	}

	function installCommand(): string {
		return osChoice === 'windows' ? windowsCommand() : unixCommand();
	}

	async function copyCommand() {
		await navigator.clipboard.writeText(installCommand());
		copied = true;
		toast(t('agents.copied'), 'success');
		setTimeout(() => copied = false, 2000);
	}

	function handleClose() {
		generatedToken = null;
		name = '';
		osChoice = 'unix';
		pinTLS = true;
		onclose();
	}
</script>

<Modal bind:open onclose={handleClose} title={t('agents.enrollment')}>
	{#if !generatedToken}
		<div class="space-y-4">
			<div>
				<label for="agent-name" class="block text-sm font-medium text-near-black mb-1">
					{t('agents.enrollmentTokenName')}
				</label>
				<input
					id="agent-name"
					type="text"
					bind:value={name}
					placeholder="e.g. web-server-01"
					class="w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-near-black placeholder:text-near-black/40 focus:outline-none focus:ring-2 focus:ring-cyan"
				/>
			</div>
			<label class="flex items-start gap-2 text-sm text-near-black">
				<input type="checkbox" bind:checked={pinTLS} class="mt-0.5" />
				<span>
					<span class="font-medium">{t('agents.pinTls')}</span>
					<span class="block text-xs text-near-black/60">{t('agents.pinTlsHelp')}</span>
				</span>
			</label>
			<Button onclick={generateToken} {loading} class="w-full">
				{t('agents.generateToken')}
			</Button>
		</div>
	{:else}
		<div class="space-y-4">
			<div class="rounded-lg bg-green-500/10 border border-green-500/20 p-3">
				<p class="text-sm font-medium text-green-700 dark:text-green-300">{t('agents.tokenGenerated')}</p>
				<p class="text-xs text-green-600 dark:text-green-400 mt-0.5">{t('agents.tokenExpires')}</p>
			</div>

			<!-- OS tab switcher -->
			<div class="flex gap-1 rounded-lg bg-bg p-1 text-sm">
				<button type="button"
					class="flex-1 rounded-md px-3 py-1.5 font-medium transition-colors {osChoice === 'unix' ? 'bg-bg-card text-near-black shadow-sm' : 'text-near-black/60 hover:text-near-black'}"
					onclick={() => osChoice = 'unix'}>
					macOS / Linux
				</button>
				<button type="button"
					class="flex-1 rounded-md px-3 py-1.5 font-medium transition-colors {osChoice === 'windows' ? 'bg-bg-card text-near-black shadow-sm' : 'text-near-black/60 hover:text-near-black'}"
					onclick={() => osChoice = 'windows'}>
					Windows
				</button>
			</div>

			<div>
				<p class="text-sm font-medium text-near-black mb-2">
					{osChoice === 'windows' ? t('agents.runCommandWindows') : t('agents.runCommand')}
				</p>
				<pre class="rounded-lg bg-[#111214] text-green-400 p-4 text-xs overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed select-all">{installCommand()}</pre>
				{#if osChoice === 'windows'}
					<p class="mt-2 text-xs text-near-black/70">{t('agents.runCommandWindowsHint')}</p>
				{/if}
			</div>

			<!-- Prominent copy button -->
			<Button onclick={copyCommand} class="w-full">
				{#if copied}
					<svg class="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
					</svg>
					{t('agents.copied')}
				{:else}
					<svg class="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
					</svg>
					{t('agents.copyCommand')}
				{/if}
			</Button>

			<Button variant="secondary" onclick={handleClose} class="w-full">
				{t('action.close')}
			</Button>
		</div>
	{/if}
</Modal>
