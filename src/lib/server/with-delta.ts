export interface DeltaResult<T> {
	added: T[];
	removed: T[];
	changed: Array<{ previous: T; current: T; reasons: string[] }>;
	unchanged: T[];
}

export interface DeltaOptions<T> {
	keyOf: (item: T) => string;
	changeFields?: ReadonlyArray<{ name: string; equals: (a: T, b: T) => boolean }>;
}

export function withDelta<T>(prev: ReadonlyArray<T>, current: ReadonlyArray<T>, opts: DeltaOptions<T>): DeltaResult<T> {
	const prevByKey = new Map<string, T>();
	for (const p of prev) prevByKey.set(opts.keyOf(p), p);
	const curByKey = new Map<string, T>();
	for (const c of current) curByKey.set(opts.keyOf(c), c);

	const added: T[] = [];
	const removed: T[] = [];
	const changed: Array<{ previous: T; current: T; reasons: string[] }> = [];
	const unchanged: T[] = [];

	for (const [k, c] of curByKey) {
		const p = prevByKey.get(k);
		if (!p) {
			added.push(c);
			continue;
		}
		if (opts.changeFields && opts.changeFields.length > 0) {
			const reasons: string[] = [];
			for (const f of opts.changeFields) {
				if (!f.equals(p, c)) reasons.push(f.name);
			}
			if (reasons.length > 0) changed.push({ previous: p, current: c, reasons });
			else unchanged.push(c);
		} else {
			unchanged.push(c);
		}
	}
	for (const [k, p] of prevByKey) {
		if (!curByKey.has(k)) removed.push(p);
	}

	return { added, removed, changed, unchanged };
}
