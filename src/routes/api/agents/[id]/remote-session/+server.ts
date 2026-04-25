import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody } from '$lib/server/request-utils.js';
import { agentRemoteDesktopSchema } from '$lib/validators-rmm.js';
import { getAgent } from '$services/agents.js';
import { db } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { issueRemoteSession, encryptAgentRemoteDesktop, getAgentRemoteDesktop } from '$services/guacamole.js';
import { listRemoteSessionsByAgent } from '$services/remote-sessions.js';
import type { AgentRemoteDesktop } from '$lib/types.js';

/**
 * Two operations on this endpoint:
 *
 *   POST { action: 'set-profile', profile: {...} }
 *     Save / update the agent's connection profile (RDP/VNC/SSH host, port,
 *     credentials). Credentials are field-encrypted on write.
 *
 *   POST {} (no action)
 *     Issue a single-use session-token for the operator to open a popup.
 *     Returns { sessionId, popupUrl, expiresAt, protocol }. Audit-logged.
 *
 *   GET
 *     List recent remote-desktop sessions for this agent (audit view).
 */

const stmtUpdateAgentData = db.prepare("UPDATE agents SET data = ?, updated_at = datetime('now') WHERE id = ?");
const stmtGetAgentData = db.prepare('SELECT data FROM agents WHERE id = ?');

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401);
	if (!getAgent(params.id)) throw error(404, 'Agent not found');
	const sessions = listRemoteSessionsByAgent(params.id, 50);
	const profile = getAgentRemoteDesktop(params.id);
	// Strip secrets — UI only needs to know whether a profile exists.
	return json({
		sessions,
		profile: profile ? {
			protocol: profile.protocol,
			port: profile.port,
			username: profile.username,
			domain: profile.domain,
			ignoreCert: profile.ignoreCert,
			recording: profile.recording,
			hasPassword: !!profile.password,
			hasPrivateKey: !!profile.privateKey
		} : null
	});
};

export const POST: RequestHandler = async ({ params, request, locals, getClientAddress }) => {
	if (!locals.user) throw error(401);
	const agent = getAgent(params.id);
	if (!agent) throw error(404, 'Agent not found');

	const body = await parseJsonBody(request) as Record<string, unknown>;
	const action = typeof body.action === 'string' ? body.action : '';

	if (action === 'set-profile') {
		const parsed = agentRemoteDesktopSchema.safeParse(body.profile);
		if (!parsed.success) throw error(400, parsed.error.issues[0].message);

		// Preserve existing secrets when the UI sends back the masked '***' sentinel
		// or an empty string — same pattern as backup credentials.
		const incoming: AgentRemoteDesktop = parsed.data;
		const existing = getAgentRemoteDesktop(params.id);
		if (existing) {
			if (incoming.password === '***' || incoming.password === '') incoming.password = existing.password;
			if (incoming.privateKey === '***' || incoming.privateKey === '') incoming.privateKey = existing.privateKey ?? '';
		}
		const encrypted = encryptAgentRemoteDesktop(incoming);

		// Merge into agents.data
		const row = stmtGetAgentData.get(params.id) as { data: string } | undefined;
		let data: Record<string, unknown> = {};
		try { if (row) data = JSON.parse(row.data); } catch { /* malformed */ }
		data.remoteDesktop = encrypted;
		stmtUpdateAgentData.run(JSON.stringify(data), params.id);
		recordChange('agent', params.id, 'update', { remoteDesktopProfile: { old: existing ? existing.protocol : null, new: encrypted.protocol } }, locals.user.id);
		return json({ ok: true });
	}

	if (action === 'clear-profile') {
		const row = stmtGetAgentData.get(params.id) as { data: string } | undefined;
		let data: Record<string, unknown> = {};
		try { if (row) data = JSON.parse(row.data); } catch { /* malformed */ }
		const had = !!data.remoteDesktop;
		delete data.remoteDesktop;
		stmtUpdateAgentData.run(JSON.stringify(data), params.id);
		if (had) recordChange('agent', params.id, 'update', { remoteDesktopProfile: { old: 'configured', new: null } }, locals.user.id);
		return json({ ok: true });
	}

	// Default: issue a session-token.
	try {
		const result = issueRemoteSession({
			agentId: params.id,
			userId: locals.user.id,
			clientIp: getClientAddress(),
			userAgent: request.headers.get('user-agent') || ''
		});
		return json({
			sessionId: result.sessionId,
			protocol: result.protocol,
			popupUrl: `/remote-desktop/${result.token}`,
			expiresAt: result.expiresAt
		}, { status: 201 });
	} catch (e) {
		throw error(400, e instanceof Error ? e.message : 'Failed to issue session');
	}
};
