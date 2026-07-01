import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` reads the schema and emits SQL migrations locally —
// no database connection and no binary download required. `migrate`/`push`
// use DATABASE_URL at deploy time.
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://devspace:devspace@localhost:5432/devspace',
  },
});
