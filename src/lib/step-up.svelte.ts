import { ApiError, getErrorMessage } from '#lib/api.js';
import { t } from '#lib/i18n/index.svelte.js';

/**
 * Step-up-gated endpoints answer 403 `MFA code required for …` when the
 * account has TOTP enabled and the request carried no `mfaCode`. Without
 * this wrapper every such action (backup restore/delete/rotate, password
 * change, remote-desktop profile, agent cleanup) dead-ends for MFA users:
 * the UI has nowhere to type the code.
 */
let pending: ((code: string | null) => void) | null = null;
let promptOpen = $state(false);
let promptLabel = $state('');
let promptError = $state('');

function settle(code: string | null) {
	promptOpen = false;
	const resolve = pending;
	pending = null;
	resolve?.(code);
}

export const stepUpPrompt = {
	get open() {
		return promptOpen;
	},
	get label() {
		return promptLabel;
	},
	get error() {
		return promptError;
	},
	submit: (code: string) => settle(code),
	cancel: () => settle(null)
};

function askForCode(label: string, error = ''): Promise<string | null> {
	promptLabel = label;
	promptError = error;
	promptOpen = true;
	return new Promise((resolve) => {
		pending = resolve;
	});
}

function isStepUpRequired(err: unknown): boolean {
	return err instanceof ApiError && err.status === 403 && /MFA code required/i.test(getErrorMessage(err));
}

export async function withStepUp<T>(
	action: (extra: { mfaCode?: string }) => Promise<T>,
	label = t('settings.mfaCodeOrRecovery')
): Promise<T> {
	let firstError: unknown;
	try {
		return await action({});
	} catch (e) {
		if (!isStepUpRequired(e)) throw e;
		firstError = e;
	}

	let error = '';
	for (;;) {
		const code = await askForCode(label, error);
		// Cancelling keeps the original "MFA code required" error so the caller's
		// toast stays actionable instead of turning into a generic failure.
		if (!code) throw firstError;
		try {
			return await action({ mfaCode: code });
		} catch (e) {
			const retryable =
				isStepUpRequired(e) ||
				(e instanceof ApiError && e.status === 401 && /MFA/i.test(getErrorMessage(e)));
			if (!retryable) throw e;
			error = getErrorMessage(e, t('toast.error'));
		}
	}
}
