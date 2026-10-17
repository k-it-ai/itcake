/**
 * Ticket tools — Tier 1, read-only. The AI's primary surface in
 * consultant mode: summarise tickets, identify patterns, draft
 * proposed responses. NO write tool here; the AI never closes,
 * edits, or sends a ticket — `propose_ticket_response` returns
 * markdown for the operator to paste, but doesn't write anything.
 */
import { z } from 'zod';
import { registerTool } from '../tool-registry.js';
import { getDocument, getDocumentsByType } from '#lib/server/db.js';
import { sanitizeRichText } from '#lib/server/sanitize.js';
import type { Ticket, Client } from '#lib/types.js';

const listSchema = z.object({
	status: z.enum(['open', 'completed', 'invoiced']).optional(),
	clientId: z.string().optional(),
	limit: z.number().int().min(1).max(100).default(20)
}).strict();

function stripHtml(s: string): string {
	return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

interface TicketSummary {
	id: string;
	ticketNumber: string;
	title: string;
	clientId: string;
	clientName: string | null;
	date: string;
	hours: number;
	status: string;
	descriptionPreview: string;
	updatedAt: string;
}

registerTool('list_tickets', {
	definition: {
		name: 'list_tickets',
		description: 'List tickets, optionally filtered by status or client. Returns id, number, title, client, date, hours, status, and a short description preview. Use this to spot recurring patterns or queue length before diving into a single ticket.',
		input_schema: {
			type: 'object',
			properties: {
				status: { type: 'string', enum: ['open', 'completed', 'invoiced'] },
				clientId: { type: 'string' },
				limit: { type: 'number', minimum: 1, maximum: 100 }
			}
		}
	},
	handler: async (raw) => {
		const input = listSchema.parse(raw);
		const all = getDocumentsByType<Ticket>('ticket');
		const clients = new Map<string, Client>();
		for (const c of getDocumentsByType<Client>('client')) clients.set(c.id, c);

		const filtered = all
			.filter(t => !input.status || t.status === input.status)
			.filter(t => !input.clientId || t.clientId === input.clientId)
			.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
			.slice(0, input.limit);

		const result: TicketSummary[] = filtered.map(t => ({
			id: t.id,
			ticketNumber: t.ticketNumber,
			title: t.title || '(untitled)',
			clientId: t.clientId,
			clientName: clients.get(t.clientId)?.name ?? null,
			date: t.date,
			hours: t.hours,
			status: t.status,
			descriptionPreview: stripHtml(t.description ?? '').slice(0, 200),
			updatedAt: t.updatedAt
		}));
		return { count: result.length, tickets: result };
	}
});

const getSchema = z.object({ id: z.string() }).strict();

registerTool('get_ticket', {
	definition: {
		name: 'get_ticket',
		description: 'Fetch a single ticket by id. Returns the full record including sanitised description, client details, and any linked invoice. Use this to read the ticket carefully before suggesting a response.',
		input_schema: {
			type: 'object',
			required: ['id'],
			properties: { id: { type: 'string' } }
		}
	},
	handler: async (raw) => {
		const input = getSchema.parse(raw);
		const t = getDocument<Ticket>(input.id, 'ticket');
		if (!t) throw new Error(`ticket ${input.id} not found`);
		const client = t.clientId ? getDocument<Client>(t.clientId, 'client') : null;
		return {
			id: t.id,
			ticketNumber: t.ticketNumber,
			title: t.title,
			status: t.status,
			date: t.date,
			startTime: t.startTime,
			hours: t.hours,
			hourlyRate: t.hourlyRate,
			invoiceId: t.invoiceId,
			notes: t.notes,
			description: stripHtml(t.description ?? ''),
			descriptionHtml: sanitizeRichText(t.description ?? ''),
			client: client ? { id: client.id, name: client.name, email: client.email } : null,
			createdAt: t.createdAt,
			updatedAt: t.updatedAt
		};
	}
});

const proposeSchema = z.object({
	ticketId: z.string(),
	resolution: z.string().min(1).max(8000),
	rationale: z.string().max(2000).optional(),
	suggestedStatus: z.enum(['open', 'completed']).optional()
}).strict();

registerTool('propose_ticket_response', {
	definition: {
		name: 'propose_ticket_response',
		description: 'Surface a proposed reply or resolution for a ticket. THIS DOES NOT WRITE OR SEND ANYTHING — the operator reviews the proposal and decides whether to paste/send it themselves. Use this to deliver your final consultant output for the ticket: include the draft text in `resolution`, optionally the reasoning in `rationale`, and a suggested status change.',
		input_schema: {
			type: 'object',
			required: ['ticketId', 'resolution'],
			properties: {
				ticketId: { type: 'string' },
				resolution: { type: 'string', description: 'The drafted response/resolution text. Markdown ok. The operator will read this and decide whether to act.' },
				rationale: { type: 'string', description: 'Short explanation of why this resolution makes sense.' },
				suggestedStatus: { type: 'string', enum: ['open', 'completed'], description: 'Optional status the operator may want to set after sending.' }
			}
		}
	},
	handler: async (raw) => {
		const input = proposeSchema.parse(raw);
		// Verify the ticket exists so the proposal references something real,
		// but DO NOT mutate it. The operator is the one who reads + acts.
		const t = getDocument<Ticket>(input.ticketId, 'ticket');
		if (!t) throw new Error(`ticket ${input.ticketId} not found`);
		return {
			kind: 'proposal',
			ticketId: t.id,
			ticketNumber: t.ticketNumber,
			currentStatus: t.status,
			suggestedStatus: input.suggestedStatus ?? null,
			resolution: input.resolution,
			rationale: input.rationale ?? null,
			note: 'This is a proposal only. itcake has not changed the ticket.'
		};
	}
});
