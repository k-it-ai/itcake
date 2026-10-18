<script lang="ts">
	import { t } from '#lib/i18n/index.svelte.js';
	import Modal from '#components/ui/Modal.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import { toast } from '#components/ui/Toast.svelte';

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
				<label for="agent-name" class="block text-[12px] font-medium mb-1" style="color:var(--ink)">
					{t('agents.enrollmentTokenName')}
				</label>
				<input
					id="agent-name"
					type="text"
					bind:value={name}
					placeholder="e.g. web-server-01"
					class="w-full rounded-md border px-3 py-1.5 text-[12.5px] focus:outline-2 focus:outline-[var(--brand)] focus:outline-offset-1"
					style="background:var(--card);border-color:var(--line);color:var(--ink)"
				/>
			</div>
			<label class="flex items-start gap-2 text-[12px]" style="color:var(--ink)">
				<input type="checkbox" bind:checked={pinTLS} class="mt-0.5" style="accent-color:var(--brand)" />
				<span>
					<span class="font-medium">{t('agents.pinTls')}</span>
					<span class="block text-[11px]" style="color:var(--muted)">{t('agents.pinTlsHelp')}</span>
				</span>
			</label>
			<Btn variant="primary" onclick={generateToken} class="w-full justify-center">
				{loading ? '…' : t('agents.generateToken')}
			</Btn>
		</div>
	{:else}
		<div class="space-y-4">
			<div class="rounded-md border p-3" style="background:var(--good-soft);border-color:#bfe2cf">
				<p class="text-[12px] font-medium" style="color:#0f5d3d">{t('agents.tokenGenerated')}</p>
				<p class="text-[11px] mt-0.5" style="color:#0f5d3d">{t('agents.tokenExpires')}</p>
			</div>

			<div class="inline-flex w-full items-center gap-0.5 rounded-md p-0.5" style="background:#fbfcfd;border:1px solid var(--line)">
				<button
					type="button"
					class="flex-1 rounded-[4px] px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1"
					style={osChoice === 'unix'
						? 'background:var(--brand-soft);color:var(--brand-ink)'
						: 'background:transparent;color:var(--muted)'}
					aria-pressed={osChoice === 'unix'}
					onclick={() => osChoice = 'unix'}
				>
					macOS / Linux
				</button>
				<button
					type="button"
					class="flex-1 rounded-[4px] px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1"
					style={osChoice === 'windows'
						? 'background:var(--brand-soft);color:var(--brand-ink)'
						: 'background:transparent;color:var(--muted)'}
					aria-pressed={osChoice === 'windows'}
					onclick={() => osChoice = 'windows'}
				>
					Windows
				</button>
			</div>

			<div>
				<p class="text-[12px] font-medium mb-2" style="color:var(--ink)">
					{osChoice === 'windows' ? t('agents.runCommandWindows') : t('agents.runCommand')}
				</p>
				<pre class="rounded-md p-4 text-[11px] overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed select-all" style="background:#0f1418;color:#cfeaff">{installCommand()}</pre>
				{#if osChoice === 'windows'}
					<p class="mt-2 text-[11px]" style="color:var(--muted)">{t('agents.runCommandWindowsHint')}</p>
				{/if}
			</div>

			<Btn variant="primary" onclick={copyCommand} class="w-full justify-center">
				{#if copied}
					<svg class="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.6">
						<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
					</svg>
					{t('agents.copied')}
				{:else}
					<svg class="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.6">
						<path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
					</svg>
					{t('agents.copyCommand')}
				{/if}
			</Btn>

			<Btn variant="ghost" onclick={handleClose} class="w-full justify-center">
				{t('action.close')}
			</Btn>
		</div>
	{/if}
</Modal>
