import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, requireUser } from '$lib/server/request-utils.js';
import { agentRemoteDesktopSchema } from '$lib/validators-rmm.js';
import { getAgent } from '$services/agents.js';
import { db } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { issueRemoteSession, encryptAgentRemoteDesktop, getAgentRemoteDesktop } from '$services/guacamole.js';
import { listRemoteSessionsByAgent } from '$services/remote-sessions.js';
import type { AgentRemoteDesktop } from '$lib/types.js';

/**
 * Three POST operations + a GET on this endpoint:
 *
 *   POST { action: 'set-profile', profile: {...} }
 *     Save / update the agent's connection profile (RDP/VNC/SSH host, port,
 *     credentials). Credentials are field-encrypted on write.
 *
 *   POST { action: 'clear-profile' }
 *     Drop the agent's remote-desktop profile entirely.
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
	requireUser(locals);
	if (!getAgent(params.id)) throw notFound();
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

export const POST: RequestHandler = ({ params, request, locals, getClientAddress }) => {
	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	const readData = (): Record<string, unknown> => {
		const row = stmtGetAgentData.get(params.id) as { data: string } | undefined;
		try { return row ? JSON.parse(row.data) : {}; } catch { return {}; }
	};

	return handleActionPost(request, locals, {
		// Default action: issue a fresh session token for the popup.
		create: (_data, userId) => {
			try {
				const result = issueRemoteSession({
					agentId: agent.id,
					userId,
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
		},
		actions: {
			'set-profile': (data, userId) => {
				const parsed = agentRemoteDesktopSchema.safeParse(data.profile);
				if (!parsed.success) throw error(400, parsed.error.issues[0].message);

				// Preserve existing secrets when the UI sends back the masked '***' sentinel
				// or an empty string — same pattern as backup credentials.
				const incoming: AgentRemoteDesktop = parsed.data;
				const existing = getAgentRemoteDesktop(agent.id);
				if (existing) {
					if (incoming.password === '***' || incoming.password === '') incoming.password = existing.password;
					if (incoming.privateKey === '***' || incoming.privateKey === '') incoming.privateKey = existing.privateKey ?? '';
				}
				const encrypted = encryptAgentRemoteDesktop(agent.id, incoming);

				const blob = readData();
				blob.remoteDesktop = encrypted;
				stmtUpdateAgentData.run(JSON.stringify(blob), agent.id);
				recordChange('agent', agent.id, 'update', { remoteDesktopProfile: { old: existing ? existing.protocol : null, new: encrypted.protocol } }, userId);
				return json({ ok: true });
			},
			'clear-profile': (_data, userId) => {
				const blob = readData();
				const had = !!blob.remoteDesktop;
				delete blob.remoteDesktop;
				stmtUpdateAgentData.run(JSON.stringify(blob), agent.id);
				if (had) recordChange('agent', agent.id, 'update', { remoteDesktopProfile: { old: 'configured', new: null } }, userId);
				return json({ ok: true });
			}
		}
	});
};
