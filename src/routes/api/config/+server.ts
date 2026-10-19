import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { hasUsers } from '#lib/server/auth.js';
import { isSetupComplete } from '#services/settings.js';

export const GET: RequestHandler = async () => {
	const needsSetup = !hasUsers() || !isSetupComplete();
	return json({ setupComplete: !needsSetup });
};
