import { PrismaClient } from "@prisma/client";

// Test database: created once on the same Postgres instance as dev/prod,
// wiped and migrated per test-suite run by tests/setup.ts.
// NOTE: 127.0.0.1:5432 on this host is lenel's ROOTLESS postgres — never
// point tests there. The hostpanel postgres container lives on the
// web-dashboard_default bridge (172.28.0.2) and is reachable from the host.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  `postgresql://postgres:${process.env.TEST_DB_PASSWORD ?? "postgres"}@172.28.0.2:5432/hostpanel_test`;

export const prisma = new PrismaClient();
