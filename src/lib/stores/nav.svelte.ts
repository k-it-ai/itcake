// Nav config + derived badge counts for the v2 Sidebar.
import type { ComponentType, SvelteComponent } from 'svelte';
import {
	Home,
	Ticket,
	FileText,
	FileSignature,
	Receipt,
	Users,
	LayoutGrid,
	BarChart3,
	Box,
	Activity,
	History,
	Settings
} from '$lib/icons';

// lucide-svelte v1.x still ships components as legacy class types
// (SvelteComponentTyped); accept any class component for icon slots.
type IconComponent = ComponentType<SvelteComponent<Record<string, any>, any, any>>;

export type NavBadgeTone = 'neutral' | 'bad';

export interface NavItem {
	id: string;
	tKey: string;
	href: string;
	icon: IconComponent;
	badge?: () => number;
	badgeTone?: NavBadgeTone;
}

export interface NavGroup {
	id: string;
	tKey: string;
	items: NavItem[];
}

let openTickets = $state(0);
let unpaidInvoices = $state(0);
let criticalFindings = $state(0);

export const navBadges = {
	get openTickets() {
		return openTickets;
	},
	setOpenTickets(n: number) {
		openTickets = Math.max(0, Math.floor(n));
	},
	get unpaidInvoices() {
		return unpaidInvoices;
	},
	setUnpaidInvoices(n: number) {
		unpaidInvoices = Math.max(0, Math.floor(n));
	},
	get criticalFindings() {
		return criticalFindings;
	},
	setCriticalFindings(n: number) {
		criticalFindings = Math.max(0, Math.floor(n));
	}
};

export const navGroups: NavGroup[] = [
	{
		id: 'workspace',
		tKey: 'sidebar.group.workspace',
		items: [
			{ id: 'dashboard', tKey: 'sidebar.dashboard', href: '/dashboard', icon: Home },
			{
				id: 'tickets',
				tKey: 'sidebar.tickets',
				href: '/tickets',
				icon: Ticket,
				badge: () => navBadges.openTickets
			},
			{
				id: 'invoices',
				tKey: 'sidebar.invoices',
				href: '/invoices',
				icon: FileText,
				badge: () => navBadges.unpaidInvoices
			},
			{ id: 'proposals', tKey: 'sidebar.proposals', href: '/proposals', icon: FileSignature },
			{ id: 'expenses', tKey: 'sidebar.expenses', href: '/expenses', icon: Receipt },
			{ id: 'clients', tKey: 'sidebar.clients', href: '/clients', icon: Users },
			{ id: 'catalog', tKey: 'sidebar.catalog', href: '/catalog', icon: LayoutGrid },
			{ id: 'reports', tKey: 'sidebar.reports', href: '/reports', icon: BarChart3 }
		]
	},
	{
		id: 'operations',
		tKey: 'sidebar.group.operations',
		items: [
			{
				id: 'agents',
				tKey: 'sidebar.agents',
				href: '/agents',
				icon: Box,
				badge: () => navBadges.criticalFindings,
				badgeTone: 'bad'
			},
			{ id: 'uptime', tKey: 'sidebar.uptime', href: '/uptime', icon: Activity },
			{ id: 'changes', tKey: 'sidebar.changes', href: '/changes', icon: History }
		]
	},
	{
		id: 'system',
		tKey: 'sidebar.group.system',
		items: [{ id: 'settings', tKey: 'sidebar.settings', href: '/settings', icon: Settings }]
	}
];

export function isActive(item: NavItem, pathname: string): boolean {
	if (item.href === '/dashboard') return pathname === '/dashboard' || pathname === '/';
	return pathname === item.href || pathname.startsWith(item.href + '/');
}
