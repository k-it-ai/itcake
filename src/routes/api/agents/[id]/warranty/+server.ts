import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, requireUser } from '#lib/server/request-utils.js';
import { getAgent } from '#services/agents.js';
import { dispatchCommand } from '#services/agent-commands.js';
import { getWarranty, setWarrantyOverride } from '#services/hardware-warranty.js';
import { LegacyEnrollmentError } from '#lib/server/agent-auth.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const agent = getAgent(params.id);
	if (!agent) throw notFound();
	return json(getWarranty(params.id));
};

export const POST: RequestHandler = ({ params, request, locals }) =>
	handleActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			collect: async (_data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				if (!agent.enabled) throw error(400, 'Agent is disabled');
				if (agent.status === 'offline') throw error(400, 'Agent is offline');
				try {
					const cmd = dispatchCommand(params.id, 'hardware_warranty_collect', {}, userId, 60);
					return json(cmd, { status: 201 });
				} catch (e) {
					if (e instanceof LegacyEnrollmentError) throw error(409, e.message);
					throw e;
				}
			},
			'set-override': async (data, userId) => {
				const agent = getAgent(params.id);
				if (!agent) throw notFound();
				try {
					const view = setWarrantyOverride(params.id, {
						warrantyEndDate: typeof data.warrantyEndDate === 'string' ? data.warrantyEndDate : undefined,
						purchaseDate: typeof data.purchaseDate === 'string' ? data.purchaseDate : undefined,
						notes: typeof data.notes === 'string' ? data.notes : undefined
					}, userId);
					return json(view);
				} catch (e) {
					throw error(400, e instanceof Error ? e.message : 'Invalid override');
				}
			}
		}
	});
