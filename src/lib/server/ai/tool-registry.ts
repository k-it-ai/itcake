import type { Tool } from '@anthropic-ai/sdk/resources/index.js';

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
