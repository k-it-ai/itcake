import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost } from '$lib/server/request-utils.js';
import {
	getOrCreateUpdateManifestKey,
	getUpdateManifestPublicKey,
	rotateUpdateManifestKey,
	removeUpdateManifestKey
} from '$services/agent-auto-update.js';
import { recordChange } from '$lib/server/changes.js';
import { db } from '$lib/server/db.js';

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		// No anonymous "create" — operators always pass an explicit action.
		create: () => json({ error: 'specify an action: generate | rotate | remove | status' }, { status: 400 }),
		actions: {
			generate: (_data, userId) => {
				const before = getUpdateManifestPublicKey();
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
			rotate: (_data, userId) => {
				const out = db.transaction(() => {
					const result = rotateUpdateManifestKey();
					recordChange(
						'settings',
						'rmm.updateManifestKey',
						'update',
						{ updateManifestKey: { old: 'rotated', new: 'rotated' } },
						userId
					);
					return result;
				})();
				return json({ publicKeyB64: out.publicKeyB64 });
			},
			remove: (_data, userId) => {
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
