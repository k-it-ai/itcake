import type { LayoutServerLoad } from './$types.js';
import { getSettingsSection } from '$services/settings.js';

export const load: LayoutServerLoad = async ({ locals }) => {
	const general = getSettingsSection('general') as Record<string, unknown>;
	return {
		user: locals.user,
		interfaceLang: (general?.language as string) || 'en'
	};
};
