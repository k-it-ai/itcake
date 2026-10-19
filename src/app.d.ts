declare global {
	namespace App {
		interface Error {
			status: number;
			message: string;
			/** Correlation id written to the server log / error report for unexpected errors. */
			id?: string;
		}
		interface Locals {
			user: { id: string; email: string; name: string; role: 'admin' | 'user' } | null;
		}
	}
}

export {};
