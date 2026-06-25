/**
 * Applies generated migrations. Run `npm run db:generate` first to produce SQL
 * under packages/db/drizzle, then `npm run db:migrate` to apply.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to .env to run migrations.');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: 'packages/db/drizzle' });
console.log('Migrations applied.');
await sql.end();
