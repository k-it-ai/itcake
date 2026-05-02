export class ServiceError extends Error {
	constructor(
		public readonly i18nKey: string,
		public readonly params?: Record<string, string | number>
	) {
		super(i18nKey);
		this.name = 'ServiceError';
	}
}
