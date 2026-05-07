import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { getAgent } from '$services/agents.js';
import { getRecentMetrics } from '$services/agent-metrics.js';
import { getCommandHistory } from '$services/agent-commands.js';
import { getPackages } from '$services/agent-inventory.js';
import { getServices } from '$services/agent-inventory.js';
import { listFindingsByAgent } from '$services/agent-findings.js';
import { getLatestCollectorResult } from '$services/agent-collector-results.js';
import { getAgentSecurityPostureCached } from '$services/security-posture.js';
import { getBootPerformanceTrend } from '$services/boot-performance.js';
import { getWarranty } from '$services/hardware-warranty.js';
import { notFound } from '$lib/server/request-utils.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const agent = getAgent(params.id);
	if (!agent) throw notFound();

	const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
	const metrics = getRecentMetrics(params.id, since48h);
	const commands = getCommandHistory(params.id, 50);
	const packages = getPackages(params.id);
	const services = getServices(params.id);
	const findings = listFindingsByAgent(params.id, 200);
	const filesystemAnalysis = getLatestCollectorResult(params.id, 'filesystem_analysis');
	const networkDiscovery = getLatestCollectorResult(params.id, 'network_discovery');
	const networkBaseline = getLatestCollectorResult(params.id, 'network_baseline');
	const peripheralInventory = getLatestCollectorResult(params.id, 'peripheral_inventory');
	const posture = getAgentSecurityPostureCached(params.id);
	const bootPerformance = getBootPerformanceTrend(params.id);
	const warranty = getWarranty(params.id);

	return {
		agent, metrics, commands, packages, services, findings,
		filesystemAnalysis, networkDiscovery, networkBaseline, peripheralInventory,
		posture, bootPerformance, warranty
	};
};
