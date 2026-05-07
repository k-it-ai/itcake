import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser } from '$lib/server/request-utils.js';
import { getGuacdStatus, installGuacd, updateGuacd, restartGuacamoleProxy } from '$services/guacamole.js';
import { recordChange } from '$lib/server/changes.js';

let inFlight = false;

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	return json(await getGuacdStatus());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);
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
				// G3 — destructive (kills any in-flight remote-desktop session)
				// and silently disruptive without an audit-log entry. Audit it
				// inside the inFlight guard the same way install/update do.
				restartGuacamoleProxy();
				recordChange('settings', 'remoteDesktop', 'update', { guacdRestart: { old: null, new: true } }, locals.user.id);
				return json({ ok: true });
			}
			default:
				throw error(400, 'Specify { action: "install" | "update" | "restart" }');
		}
	} finally {
		inFlight = false;
	}
};
