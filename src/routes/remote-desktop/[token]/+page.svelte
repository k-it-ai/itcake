<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { PageData } from './$types.js';
	import type { Client as GuacClient } from 'guacamole-common-js';

	let { data }: { data: PageData } = $props();
	let displayEl: HTMLDivElement;
	let statusText = $state('Connecting…');
	let connected = $state(false);
	let errorText = $state<string | null>(null);
	let client: GuacClient | null = null;

	onMount(async () => {
		// Lazy import — guacamole-common-js is only pulled on this popup page,
		// so the main bundle stays slim.
		const Guacamole = (await import('guacamole-common-js')).default;
		// WebSocket points at /api/remote-desktop/ws which the reverse proxy
		// forwards to the localhost guacamole-lite proxy port. The actual
		// authorization is the encrypted token in the query string.
		const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const tunnelUrl = `${wsProto}//${window.location.host}/api/remote-desktop/ws`;

		const tunnel = new Guacamole.WebSocketTunnel(tunnelUrl);
		client = new Guacamole.Client(tunnel);
		displayEl.appendChild(client.getDisplay().getElement());

		client.onstatechange = (state: number) => {
			// 0 IDLE, 1 CONNECTING, 2 WAITING, 3 CONNECTED, 4 DISCONNECTING, 5 DISCONNECTED
			if (state === 3) { connected = true; statusText = 'Connected'; }
			else if (state === 5) { connected = false; statusText = 'Disconnected'; window.close(); }
		};
		client.onerror = (status) => {
			errorText = status.message || 'Connection error';
			statusText = 'Error';
		};

		const c = client;
		const mouse = new Guacamole.Mouse(displayEl);
		mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (s) => c.sendMouseState(s);
		const keyboard = new Guacamole.Keyboard(document);
		keyboard.onkeydown = (k) => c.sendKeyEvent(1, k);
		keyboard.onkeyup = (k) => c.sendKeyEvent(0, k);

		c.connect(`token=${encodeURIComponent(data.guacToken)}`);
	});

	onDestroy(() => {
		try { client?.disconnect(); } catch { /* ignore */ }
	});
</script>

<svelte:head>
	<title>Remote Desktop — {data.protocol.toUpperCase()}</title>
</svelte:head>

<div class="rd-frame">
	<div class="rd-bar">
		<span class="rd-status" class:connected>{statusText}</span>
		<span class="rd-meta">{data.protocol.toUpperCase()} · max {data.maxSessionMinutes} min</span>
		<button class="rd-close" onclick={() => { try { client?.disconnect?.(); } catch { /* ignore */ } window.close(); }}>Disconnect</button>
	</div>
	{#if errorText}
		<div class="rd-error">{errorText}</div>
	{/if}
	<div class="rd-display" bind:this={displayEl}></div>
</div>

<style>
	:global(html), :global(body) { margin: 0; height: 100%; background: #000; color: #eee; font-family: ui-sans-serif, system-ui, sans-serif; }
	.rd-frame { display: flex; flex-direction: column; height: 100vh; width: 100vw; }
	.rd-bar { display: flex; align-items: center; gap: 1rem; padding: 0.4rem 0.8rem; background: #111; border-bottom: 1px solid #333; font-size: 0.85rem; }
	.rd-status { color: #f88; }
	.rd-status.connected { color: #8f8; }
	.rd-meta { color: #888; flex: 1; }
	.rd-close { background: #333; color: #eee; border: none; padding: 0.3rem 0.8rem; border-radius: 4px; cursor: pointer; font: inherit; }
	.rd-close:hover { background: #444; }
	.rd-error { background: #400; color: #fdd; padding: 0.5rem 0.8rem; border-bottom: 1px solid #600; }
	.rd-display { flex: 1; overflow: auto; display: flex; align-items: center; justify-content: center; }
	.rd-display :global(canvas) { image-rendering: pixelated; }
</style>
