import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db.js';

const stmtHealthCheck = db.prepare('SELECT 1 AS ok');

export const GET: RequestHandler = async () => {
	try {
		stmtHealthCheck.get();
		return json({ status: 'ok' });
	} catch {
		return json({ status: 'error' }, { status: 503 });
	}
};
