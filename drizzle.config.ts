import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  driver: 'libsql',
  dbCredentials: {
    url: `file:${process.env.DB_PATH || './data.db'}`,
  },
} satisfies Config;
