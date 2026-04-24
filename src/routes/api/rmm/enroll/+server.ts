import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { enrollRequestSchema } from '$lib/validators-rmm.js';
import { enrollAgent } from '$services/agents.js';
import { checkAndRecordAttempt } from '$lib/server/rate-limit.js';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const ip = getClientAddress();
	try {
		checkAndRecordAttempt(`enroll:${ip}`, 10, 'Too many enrollment attempts');
	} catch {
		return json({ error: 'Too many enrollment attempts' }, { status: 429 });
	}

	let body: unknown;
	try {
		body = await parseJsonBody(request);
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = enrollRequestSchema.safeParse(body);
	if (!parsed.success) {
		return json({ error: parsed.error.issues.map(i => i.message).join(', ') }, { status: 400 });
	}

	const { token, hostname, os, arch, osVersion, agentVersion, hmacSecret } = parsed.data;
	const userAgent = request.headers.get('user-agent') ?? '';

	try {
		const result = enrollAgent(
			token,
			{ hostname, os, arch, osVersion, agentVersion, hmacSecret: hmacSecret ?? '' },
			ip,
			userAgent
		);
		return json({
			agentId: result.agent.id,
			token: result.bearerToken,
			name: result.agent.name
		}, { status: 201 });
	} catch (e) {
		if (e instanceof Error) {
			if (e.message === 'INVALID_TOKEN') return json({ error: 'Invalid or already used enrollment token' }, { status: 401 });
			if (e.message === 'TOKEN_EXPIRED') return json({ error: 'Enrollment token has expired' }, { status: 401 });
			if (e.message === 'INVALID_HMAC_SECRET') return json({ error: 'Invalid hmacSecret: must be 32-128 lowercase hex characters' }, { status: 400 });
		}
		console.error('Agent enrollment failed:', e instanceof Error ? e.message : e);
		return json({ error: 'Enrollment failed' }, { status: 500 });
	}
};
