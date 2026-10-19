<script lang="ts" module>
	interface ToastMessage {
		id: number;
		message: string;
		type: 'success' | 'error' | 'info';
		timerId: ReturnType<typeof setTimeout> | null;
		remaining: number;
		startedAt: number;
	}

	let nextId = 0;
	let items: ToastMessage[] = $state([]);

	function dismiss(id: number) {
		const item = items.find((i) => i.id === id);
		if (item?.timerId) clearTimeout(item.timerId);
		items = items.filter((i) => i.id !== id);
	}

	function startTimer(item: ToastMessage) {
		item.startedAt = Date.now();
		item.timerId = setTimeout(() => dismiss(item.id), item.remaining);
	}

	export function toast(message: string, type: ToastMessage['type'] = 'success', duration?: number) {
		const effectiveDuration = duration ?? (type === 'error' ? 6000 : 3000);
		const id = nextId++;
		const item: ToastMessage = { id, message, type, timerId: null, remaining: effectiveDuration, startedAt: 0 };
		items = [...items, item];
		startTimer(item);
	}

	function pauseTimer(item: ToastMessage) {
		if (item.timerId) {
			clearTimeout(item.timerId);
			item.timerId = null;
			item.remaining -= Date.now() - item.startedAt;
		}
	}

	function resumeTimer(item: ToastMessage) {
		if (!item.timerId && item.remaining > 0) {
			startTimer(item);
		}
	}
</script>

<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { t } from '#lib/i18n/index.svelte.js';

	const typeClasses = {
		success: 'bg-green-600 text-white',
		error: 'bg-bad text-white',
		info: 'bg-brand text-white'
	};
</script>

{#if items.length > 0}
	<div class="fixed bottom-20 right-4 lg:bottom-4 z-[100] flex flex-col gap-2">
		{#each items as item (item.id)}
			<div
				role={item.type === 'error' ? 'alert' : 'status'}
				aria-live={item.type === 'error' ? 'assertive' : 'polite'}
				class="flex items-center gap-2 rounded-lg px-4 py-3 shadow-lg text-sm font-medium {typeClasses[item.type]}"
				in:fly={{ x: 100, duration: 200 }}
				out:fade={{ duration: 150 }}
				onmouseenter={() => pauseTimer(item)}
				onmouseleave={() => resumeTimer(item)}
			>
				<span>{item.message}</span>
				<button
					onclick={() => dismiss(item.id)}
					class="ml-1 shrink-0 rounded p-1.5 opacity-70 hover:opacity-100 transition-opacity"
					aria-label={t('aria.dismiss')}
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
		{/each}
	</div>
{/if}
