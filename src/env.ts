import { z } from 'zod';

// SvelteKit 3 reads `src/env.ts` to generate the runtime schema for
// `$app/env/private`. Every variable the server reads at runtime must be
// declared here or it is `undefined` even when set in the environment.
// They are all optional because the app boots with defaults/validation at
// the call sites (db.ts derives DATA_DIR, hooks derive ORIGIN, etc.).
const optionalString = z.string().optional();

export const variables = {
	SESSION_SECRET: { schema: optionalString },
	FIELD_ENCRYPTION_KEY: { schema: optionalString },
	NODE_ENV: { schema: optionalString },
	HOST: { schema: optionalString },
	PORT: { schema: optionalString },
	ORIGIN: { schema: optionalString },
	DATA_DIR: { schema: optionalString },
	DATABASE_PATH: { schema: optionalString },
	PUPPETEER_NO_SANDBOX: { schema: optionalString },
	TRUST_PROXY: { schema: optionalString },
	LOG_LEVEL: { schema: optionalString },
	ADDRESS_HEADER: { schema: optionalString }
};
