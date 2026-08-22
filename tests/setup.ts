import { execSync } from "node:child_process";
import path from "node:path";
import { TEST_DATABASE_URL } from "./helpers/db";

/**
 * Global test setup: point Prisma at the test database, run migrations,
 * and reset between test files. Tests must never touch the real database.
 *
 * NOTE: the repo `.env` is auto-loaded by the Prisma CLI, so DATABASE_URL is
 * passed explicitly on the command line (--url is not supported by
 * `migrate reset`, hence the env override on the child process).
 */
const repoRoot = path.resolve(__dirname, "..");

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_CREDENTIALS_KEY = process.env.NODE_CREDENTIALS_KEY ?? "a".repeat(64);
process.env.DEPLOYMENT_SECRETS_KEY = process.env.DEPLOYMENT_SECRETS_KEY ?? "b".repeat(64);
process.env.NOTIFICATION_DESTINATIONS_KEY = process.env.NOTIFICATION_DESTINATIONS_KEY ?? "c".repeat(64);
process.env.SMTP_CREDENTIALS_KEY = process.env.SMTP_CREDENTIALS_KEY ?? "d".repeat(64);
process.env.PLATFORM_PUBLIC_BASE_URL = "https://platform.noderaft.ee";
// Vitest loads the repository .env before setup; force the deterministic test
// origin so production's VPN URL can never leak into payload assertions.
process.env.HOSTPANEL_PUBLIC_BASE_URL = "https://hostpanel.test";
process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "true";
process.env.NOTIFICATION_RETRY_DELAY_2_MS = "1";
process.env.NOTIFICATION_RETRY_DELAY_3_MS = "1";
process.env.PAM_BRIDGE_URL = "http://127.0.0.1:19999";
process.env.PAM_BRIDGE_KEY = "test-pam-key";
process.env.PAM_ADMIN_USERS = "rene";

export function resetDatabase(): void {
  execSync("npx prisma migrate reset --force --skip-seed --skip-generate", {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      // Prevent the repo .env from overriding our test database.
      DOTENV_CONFIG_PATH: "/dev/null"
    },
    stdio: "pipe"
  });
}
