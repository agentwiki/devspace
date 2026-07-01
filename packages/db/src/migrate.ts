/**
 * Apply committed migrations at service boot. The migrations folder ships with
 * the package (`files: ["dist","drizzle"]`), so it resolves relative to this
 * compiled module: `dist/migrate.js` → `../drizzle`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

export function migrationsFolder(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
}

/** Run all pending migrations. Idempotent (drizzle tracks applied migrations). */
export async function runMigrations(pool: Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder: migrationsFolder() });
}
