import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Test database connection.
 *
 * NOTE: 127.0.0.1:5432 on the deploy host is lenel's ROOTLESS postgres — never
 * point tests there. The hostpanel postgres container lives on the
 * web-dashboard_default bridge (172.28.0.2).
 *
 * Credentials come from `.env.test` (gitignored) which defines a dedicated
 * `hostpanel_test` role, so tests never use the production DB password.
 */
function loadTestUrl(): string {
  if (process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }
  const envFile = path.resolve(__dirname, "../../.env.test");
  if (fs.existsSync(envFile)) {
    const line = fs
      .readFileSync(envFile, "utf8")
      .split("\n")
      .find((l) => l.startsWith("TEST_DATABASE_URL="));
    if (line) {
      return line.slice("TEST_DATABASE_URL=".length).trim();
    }
  }
  throw new Error(
    "TEST_DATABASE_URL is not set. Create .env.test with a TEST_DATABASE_URL pointing at hostpanel_test."
  );
}

export const TEST_DATABASE_URL = loadTestUrl();

export const prisma = new PrismaClient();
