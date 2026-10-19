import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, requireAdmin } from '#lib/server/request-utils.js';
import {
	getOrCreateUpdateManifestKey,
	getUpdateManifestPublicKey,
	rotateUpdateManifestKey,
	removeUpdateManifestKey
} from '#services/agent-auto-update.js';
import { recordChange } from '#lib/server/changes.js';
import { requireMfaStepUp } from '#lib/server/mfa-step-up.js';
import { db } from '#lib/server/db.js';

export const POST: RequestHandler = ({ request, locals }) => {
	requireAdmin(locals);
	return handleActionPost(request, locals, {
		create: () => json({ error: 'specify an action: generate | rotate | remove | status' }, { status: 400 }),
		actions: {
			generate: (data, userId) => {
				const before = getUpdateManifestPublicKey();
				if (!before) requireMfaStepUp(userId, data, 'manifest-key generate');
				const out = db.transaction(() => {
					const result = getOrCreateUpdateManifestKey();
					if (!before) {
						recordChange(
							'settings',
							'rmm.updateManifestKey',
							'update',
							{ updateManifestKey: { old: null, new: 'generated' } },
							userId
						);
					}
					return result;
				})();
				return json({ publicKeyB64: out.publicKeyB64, generated: !before });
			},
			rotate: (data, userId) => {
				requireMfaStepUp(userId, data, 'manifest-key rotate');
				const out = db.transaction(() => {
					const result = rotateUpdateManifestKey();
					recordChange(
						'settings',
						'rmm.updateManifestKey',
						'update',
						{ updateManifestKey: { old: 'rotated', new: result.rotationAnnouncement ? 'rotated+announced' : 'rotated' } },
						userId
					);
					return result;
				})();
				return json({
					publicKeyB64: out.publicKeyB64,
					rotationAnnounced: !!out.rotationAnnouncement
				});
			},
			remove: (data, userId) => {
				requireMfaStepUp(userId, data, 'manifest-key remove');
				db.transaction(() => {
					const before = getUpdateManifestPublicKey();
					removeUpdateManifestKey();
					if (before) {
						recordChange(
							'settings',
							'rmm.updateManifestKey',
							'update',
							{ updateManifestKey: { old: 'configured', new: null } },
							userId
						);
					}
				})();
				return json({ ok: true });
			},
			status: () => {
				const pub = getUpdateManifestPublicKey();
				return json({ configured: !!pub, publicKeyB64: pub });
			}
		}
	});
};
