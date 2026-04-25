import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { getGuacdStatus, installGuacd, updateGuacd, restartGuacamoleProxy } from '$services/guacamole.js';
import { recordChange } from '$lib/server/changes.js';

let inFlight = false;

/**
 * Admin endpoint for managing the host-side guacd binary.
 *
 *   GET                       → status (installed? version? reachable? port?)
 *   POST { action: 'install' } → install via OS package manager (sudo -n)
 *   POST { action: 'update'  } → upgrade via OS package manager
 *   POST { action: 'restart' } → restart the guacamole-lite WS proxy in-process
 *
 * Install/update will fail if the user running ITCake doesn't have
 * NOPASSWD sudo for the relevant package-manager command. That's a
 * deliberate operator decision — documented in the runbook.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
	return json(await getGuacdStatus());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);
	const body = await parseJsonBody(request) as { action?: string };
	if (inFlight) throw error(409, 'guacd operation already running');
	inFlight = true;
	try {
		switch (body.action) {
			case 'install': {
				const r = await installGuacd();
				recordChange('settings', 'remoteDesktop', 'update', { guacdInstall: { old: null, new: { ok: r.ok, manager: r.manager } } }, locals.user.id);
				return json(r);
			}
			case 'update': {
				const r = await updateGuacd();
				recordChange('settings', 'remoteDesktop', 'update', { guacdUpdate: { old: null, new: { ok: r.ok, manager: r.manager } } }, locals.user.id);
				return json(r);
			}
			case 'restart': {
				restartGuacamoleProxy();
				return json({ ok: true });
			}
			default:
				throw error(400, 'Specify { action: "install" | "update" | "restart" }');
		}
	} finally {
		inFlight = false;
	}
};
