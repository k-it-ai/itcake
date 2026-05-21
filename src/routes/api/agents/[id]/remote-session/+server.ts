import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, requireUser } from '$lib/server/request-utils.js';
import { agentRemoteDesktopSchema } from '$lib/validators-rmm.js';
import { getAgent } from '$services/agents.js';
import { db } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { issueRemoteSession, encryptAgentRemoteDesktop, getAgentRemoteDesktop } from '$services/guacamole.js';
import { listRemoteSessionsByAgent } from '$services/remote-sessions.js';
import { requireMfaStepUp } from '$lib/server/mfa-step-up.js';
import type { AgentRemoteDesktop } from '$lib/types.js';

const stmtUpdateAgentData = db.prepare("UPDATE agents SET data = ?, updated_at = datetime('now') WHERE id = ?");
const stmtGetAgentData = db.prepare('SELECT data FROM agents WHERE id = ?');

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	if (!getAgent(params.id)) throw notFound();
	const sessions = listRemoteSessionsByAgent(params.id, 50);
	const profile = getAgentRemoteDesktop(params.id);
	return json({
		sessions,
		profile: profile ? {
			protocol: profile.protocol,
			host: profile.host,
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
	requireUser(locals);
	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	const readData = (): Record<string, unknown> => {
		const row = stmtGetAgentData.get(params.id) as { data: string } | undefined;
		try { return row ? JSON.parse(row.data) : {}; } catch { return {}; }
	};

	return handleActionPost(request, locals, {
		create: (data, userId) => {
			requireMfaStepUp(userId, data, 'remote desktop session');
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
				// MFA step-up is required: a SessionOnly attacker (cookie lifted,
				// password/TOTP unknown) could otherwise rewrite the agent's
				// `host` + credentials, then wait for the operator's next
				// MFA-gated remote-desktop session to be silently redirected to
				// an attacker-controlled RDP/VNC/SSH backend.
				requireMfaStepUp(userId, data, 'remote desktop profile');

				const parsed = agentRemoteDesktopSchema.safeParse(data.profile);
				if (!parsed.success) throw error(400, parsed.error.issues[0].message);

				const incoming: AgentRemoteDesktop = parsed.data;
				const existing = getAgentRemoteDesktop(agent.id);
				if (existing) {
					if (incoming.password === '***' || incoming.password === '') incoming.password = existing.password;
					if (incoming.privateKey === '***' || incoming.privateKey === '') incoming.privateKey = existing.privateKey ?? '';
				}
				const encrypted = encryptAgentRemoteDesktop(agent.id, incoming);

				db.transaction(() => {
					const blob = readData();
					blob.remoteDesktop = encrypted;
					stmtUpdateAgentData.run(JSON.stringify(blob), agent.id);
					// Record every operator-visible field — host, port, username,
					// domain, ignoreCert, recording, plus has-password/has-privateKey
					// booleans. The previous diff captured only `protocol`, so a
					// covert host or credential change left no audit trail. We
					// store the booleans (not the ciphertexts) for the secret
					// fields — same pattern services/settings.ts uses for the
					// SMTP / S3 / WebDAV credential diffs.
					const oldSnapshot = existing
						? {
							protocol: existing.protocol,
							host: existing.host,
							port: existing.port,
							username: existing.username ?? '',
							domain: existing.domain ?? '',
							ignoreCert: existing.ignoreCert === true,
							recording: existing.recording ?? null,
							hasPassword: !!existing.password,
							hasPrivateKey: !!existing.privateKey
						}
						: null;
					const newSnapshot = {
						protocol: encrypted.protocol,
						host: encrypted.host,
						port: encrypted.port,
						username: encrypted.username ?? '',
						domain: encrypted.domain ?? '',
						ignoreCert: encrypted.ignoreCert === true,
						recording: encrypted.recording ?? null,
						hasPassword: !!encrypted.password,
						hasPrivateKey: !!encrypted.privateKey
					};
					recordChange('agent', agent.id, 'update', {
						remoteDesktopProfile: { old: oldSnapshot, new: newSnapshot }
					}, userId);
				})();
				return json({ ok: true });
			},
			'clear-profile': (data, userId) => {
				// Same threat model as `set-profile` — MFA step-up gates the
				// mutation so a SessionOnly attacker can't wipe the profile to
				// force re-configuration via a separate vector.
				requireMfaStepUp(userId, data, 'remote desktop profile');
				db.transaction(() => {
					const blob = readData();
					const had = !!blob.remoteDesktop;
					delete blob.remoteDesktop;
					stmtUpdateAgentData.run(JSON.stringify(blob), agent.id);
					if (had) recordChange('agent', agent.id, 'update', { remoteDesktopProfile: { old: 'configured', new: null } }, userId);
				})();
				return json({ ok: true });
			}
		}
	});
};
