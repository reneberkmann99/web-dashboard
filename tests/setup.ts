import { execSync } from "node:child_process";
import path from "node:path";
import { TEST_DATABASE_URL } from "./helpers/db";

/**
 * Global test setup: point Prisma at the test database, run migrations,
 * and reset between test files. Tests must never touch the real database.
 */
const repoRoot = path.resolve(__dirname, "..");

// Every test process gets the test DB; never the dev/prod one.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_CREDENTIALS_KEY = process.env.NODE_CREDENTIALS_KEY ?? "a".repeat(64);
process.env.PAM_BRIDGE_URL = "http://127.0.0.1:19999"; // never reachable in tests
process.env.PAM_BRIDGE_KEY = "test-key";
process.env.PAM_ADMIN_USERS = "rene";

// Reset schema: drop all tables, re-apply migrations, regenerate client.
export function resetDatabase(): void {
  execSync("npx prisma migrate reset --force --skip-seed", {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe"
  });
}
