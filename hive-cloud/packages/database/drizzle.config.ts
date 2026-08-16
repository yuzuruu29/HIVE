import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || "postgres://hive:hive@localhost:5432/hive_cloud",
  },
  strict: true,
  verbose: true,
});
