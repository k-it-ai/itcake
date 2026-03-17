import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { hasUsers } from '$lib/server/auth.js';
import { isSetupComplete } from '$services/settings.js';

export const GET: RequestHandler = async () => {
	// Only expose a single boolean — don't leak hasUsers to unauthenticated clients.
	// An attacker could use hasUsers=false to identify fresh instances open for registration.
	// The frontend uses server-side redirects (not this endpoint) for routing decisions.
	const needsSetup = !hasUsers() || !isSetupComplete();
	return json({ setupComplete: !needsSetup });
};
