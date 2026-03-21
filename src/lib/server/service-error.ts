/**
 * Typed error class for service-layer errors with i18n support.
 * Carries an i18n key + optional params. Translation happens at the API boundary.
 */
export class ServiceError extends Error {
	constructor(
		public readonly i18nKey: string,
		public readonly params?: Record<string, string | number>
	) {
		super(i18nKey);
		this.name = 'ServiceError';
	}
}
