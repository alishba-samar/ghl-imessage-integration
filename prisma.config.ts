import "dotenv/config";
import { defineConfig } from "prisma/config";

// This config is only read by the Prisma CLI (migrate, studio, db pull, ...).
// The CLI uses the direct Neon connection: migrations take session-level advisory locks,
// which the pooler (PgBouncer, transaction mode) doesn't support reliably.
// The app runtime connects separately via DATABASE_URL (pooled) in src/config/db.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DIRECT_URL"],
  },
});
