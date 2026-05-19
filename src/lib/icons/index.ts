// Re-exports of the v2 icon set per assets/design/handoff-v2/03-primitives.md.
// Use `size={14}` for inline icons, `size={16}` for nav icons; pin
// `strokeWidth={1.6}` globally for visual match.
//
// lucide-svelte v1 renamed several icons (Home → House, MoreHorizontal →
// Ellipsis, FileSignature → Signature, BarChart3 → ChartBar, AlertCircle →
// CircleAlert, HelpCircle → CircleHelp). We alias them here so callers can
// use the spec-original names.

export {
	Search,
	Plus,
	ChevronDown,
	Ellipsis as MoreHorizontal,
	ArrowRight,
	Check,
	X,
	Download,
	FileText,
	Paperclip,
	Euro,
	House as Home,
	Ticket,
	Signature as FileSignature,
	Receipt,
	Users,
	LayoutGrid,
	ChartBar as BarChart3,
	Box,
	Activity,
	History,
	Settings,
	CircleAlert as AlertCircle,
	Inbox,
	LogOut,
	Command,
	Cog
} from 'lucide-svelte';
