import type { Tool } from '@anthropic-ai/sdk/resources/index.js';
import { TOOL_TIERS } from './guardrails.js';

export interface AiToolHandlerCtx {
	userId: string;
	sessionId: string;
}

export interface AiTool {
	definition: Tool;
	handler: (input: Record<string, unknown>, ctx: AiToolHandlerCtx) => Promise<unknown>;
}

const registry = new Map<string, AiTool>();

export function registerTool(name: string, tool: AiTool): void {
	if (registry.has(name)) throw new Error(`AI tool already registered: ${name}`);
	registry.set(name, tool);
}

export function getTool(name: string): AiTool | undefined {
	return registry.get(name);
}

export function getRegisteredToolNames(): string[] {
	return [...registry.keys()];
}

export function getToolDefinitions(): Tool[] {
	return [...registry.values()].map(t => t.definition);
}

/**
 * Tool list scoped to the operator's AI configuration. In consultant
 * mode the model never sees Tier 2+ tools — the guardrail is still the
 * security boundary, but hiding them avoids the model wasting tokens
 * constructing dispatch calls that will immediately fail.
 */
export function getToolDefinitionsForMode(opts: { consultantMode: boolean }): Tool[] {
	if (!opts.consultantMode) return getToolDefinitions();
	return [...registry.entries()]
		.filter(([name]) => (TOOL_TIERS as Record<string, number>)[name] === 1)
		.map(([, t]) => t.definition);
}
