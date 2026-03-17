/**
 * Track unsaved changes and warn on page unload.
 * Usage in Svelte 5 components:
 *
 *   import { useUnsavedWarning } from '$lib/unsaved-warning.svelte.js';
 *   const dirty = useUnsavedWarning();
 *   // Set dirty.value = true when form changes
 *   // Set dirty.value = false after save
 *
 * The first `dirty.value = true` is ignored (initial render).
 * Call `dirty.value = false` or `dirty.init()` to arm the guard.
 */
import { onMount } from 'svelte';
import { beforeNavigate } from '$app/navigation';
import { t } from '$lib/i18n/index.svelte.js';

export function useUnsavedWarning() {
	let isDirty = $state(false);
	let armed = false;

	onMount(() => {
		// Arm after the first tick so initial $effect runs are ignored
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
	// It auto-cleans when the component unmounts, preventing stale guard accumulation.
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
		/** Explicitly arm the guard (e.g. after initial data load) */
		init() { armed = true; isDirty = false; }
	};
}
