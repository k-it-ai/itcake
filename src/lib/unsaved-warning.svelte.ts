import { onMount } from 'svelte';
import { beforeNavigate } from '$app/navigation';
import { t } from '#lib/i18n/index.svelte.js';

export function useUnsavedWarning() {
	let isDirty = $state(false);
	let armed = false;

	onMount(() => {
		queueMicrotask(() => { armed = true; });

		function handleBeforeUnload(e: BeforeUnloadEvent) {
			if (isDirty) {
				e.preventDefault();
			}
		}
		window.addEventListener('beforeunload', handleBeforeUnload);
		return () => window.removeEventListener('beforeunload', handleBeforeUnload);
	});

	// beforeNavigate must be called during component initialization (which onMount satisfies).
	onMount(() => {
		beforeNavigate(({ cancel }) => {
			if (isDirty && !confirm(t('dialog.unsavedChanges'))) {
				cancel();
			}
		});
	});

	return {
		get value() { return isDirty; },
		set value(v: boolean) {
			if (v && !armed) return; // Ignore initial render sets
			isDirty = v;
			if (!v) armed = true; // Re-arm after explicit reset
		},
		init() { armed = true; isDirty = false; }
	};
}
