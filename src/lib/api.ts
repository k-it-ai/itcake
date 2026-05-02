type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface ApiOptions {
	body?: unknown;
	params?: Record<string, string>;
}

class ApiError extends Error {
	constructor(
		public status: number,
		public data: unknown
	) {
		super(`API error ${status}`);
		this.name = 'ApiError';
	}
}

async function request<T>(method: Method, path: string, options?: ApiOptions): Promise<T> {
	const url = new URL(path, window.location.origin);
	if (options?.params) {
		for (const [key, value] of Object.entries(options.params)) {
			url.searchParams.set(key, value);
		}
	}

	const init: RequestInit = {
		method,
		headers: { 'Content-Type': 'application/json' }
	};

	if (options?.body && method !== 'GET') {
		init.body = JSON.stringify(options.body);
	}

	const res = await fetch(url.toString(), init);

	if (!res.ok) {
		const data = await res.json().catch(() => ({ message: res.statusText }));
		throw new ApiError(res.status, data);
	}

	if (res.status === 204) return undefined as T;
	return res.json();
}

export const api = {
	get: <T>(path: string, params?: Record<string, string>) =>
		request<T>('GET', path, { params }),
	post: <T>(path: string, body?: unknown) =>
		request<T>('POST', path, { body })
};

export function getErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
	if (err instanceof ApiError) {
		const d = err.data as Record<string, unknown> | undefined;
		return typeof d?.message === 'string' ? d.message : fallback;
	}
	if (err instanceof Error) return err.message || fallback;
	return fallback;
}
