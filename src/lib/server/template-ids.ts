/**
 * Built-in invoice/proposal template identifiers.
 *
 * Kept in a dependency-free module so both the database layer (which needs the
 * valid set for its migration) and the template service can share it without a
 * circular import.
 */
export const BUILT_IN_TEMPLATES: readonly string[] = ['itcake'];

export const DEFAULT_TEMPLATE_ID = 'itcake';
