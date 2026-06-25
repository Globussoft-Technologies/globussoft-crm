import type { Config } from 'drizzle-kit';

/**
 * Drizzle Kit config. Generate SQL migrations with:
 *   npm run db:generate
 * then apply them with:
 *   npm run db:migrate
 */
export default {
  schema: './packages/db/src/schema.ts',
  out: './packages/db/drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config;
