import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireUser } from '#lib/server/request-utils.js';
import { getSession, closeSession, getSessionTranscript } from '#services/ai-session.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const id = String(params.id);
	const s = getSession(id);
	if (!s || s.userId !== locals.user!.id) throw error(404, 'session not found');
	return json({ session: s, transcript: getSessionTranscript(id) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const id = String(params.id);
	const s = getSession(id);
	if (!s || s.userId !== locals.user!.id) throw error(404, 'session not found');
	closeSession(id, locals.user!.id);
	return json({ ok: true });
};
