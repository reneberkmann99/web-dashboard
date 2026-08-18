import crypto from "node:crypto";
import { Role } from "@prisma/client";
import { prisma } from "./db";
import { hashPassword } from "@/server/auth/password";
import { encryptSecret } from "@/server/security/crypto";
import type { AuthSession } from "@/server/auth/session";

/**
 * Fixture factory — creates a self-contained world: two clients, a handful of
 * users across the four roles, two nodes (rootful + rootless), containers,
 * grants, and returns ids so tests can reference them.
 */
export async function seedWorld() {
  // Unique suffixes keep repeated seedWorld() calls (one per test) from
  // colliding on unique constraints.
  const suffix = crypto.randomUUID().slice(0, 8);

  const clientA = await prisma.clientAccount.create({
    data: { name: `Client A ${suffix}`, slug: `client-a-${suffix}` }
  });
  const clientB = await prisma.clientAccount.create({
    data: { name: `Client B ${suffix}`, slug: `client-b-${suffix}` }
  });

  const node1 = await prisma.node.create({
    data: {
      name: `Node 1 ${suffix}`,
      hostname: `node-1-${suffix}.test`,
      apiBaseUrl: "http://agent:8081",
      apiKeyEncrypted: encryptSecret("test-agent-key-node1"),
      status: "ONLINE",
      isActive: true
    }
  });
  const node2 = await prisma.node.create({
    data: {
      name: `Node 2 ${suffix}`,
      hostname: `node-2-${suffix}.test`,
      apiBaseUrl: "http://agent2:8082",
      apiKeyEncrypted: encryptSecret("test-agent-key-node2"),
      status: "ONLINE",
      isActive: true
    }
  });

  const password = await hashPassword("Sup3rSecret!42");

  const adminA = await prisma.user.create({
    data: {
      email: `admin-${suffix}@hostpanel.local`,
      displayName: "Platform Admin",
      passwordHash: password,
      role: Role.ADMIN,
      isActive: true
    }
  });
  const clientAAdmin = await prisma.user.create({
    data: {
      email: `a-admin-${suffix}@client-a.local`,
      displayName: "A Admin",
      passwordHash: password,
      role: Role.CLIENT_ADMIN,
      clientAccountId: clientA.id,
      isActive: true
    }
  });
  const clientAOperator = await prisma.user.create({
    data: {
      email: `a-op-${suffix}@client-a.local`,
      displayName: "A Operator",
      passwordHash: password,
      role: Role.CLIENT_OPERATOR,
      clientAccountId: clientA.id,
      isActive: true
    }
  });
  const clientAViewer = await prisma.user.create({
    data: {
      email: `a-view-${suffix}@client-a.local`,
      displayName: "A Viewer",
      passwordHash: password,
      role: Role.CLIENT_VIEWER,
      clientAccountId: clientA.id,
      isActive: true
    }
  });
  const clientBOperator = await prisma.user.create({
    data: {
      email: `b-op-${suffix}@client-b.local`,
      displayName: "B Operator",
      passwordHash: password,
      role: Role.CLIENT_OPERATOR,
      clientAccountId: clientB.id,
      isActive: true
    }
  });

  // Containers on node1: web + worker; node2: api
  const web = await prisma.container.create({
    data: {
      nodeId: node1.id,
      dockerContainerId: "web1234567890",
      dockerName: "web",
      image: "nginx:latest",
      lastKnownStatus: "running",
      isActive: true
    }
  });
  const worker = await prisma.container.create({
    data: {
      nodeId: node1.id,
      dockerContainerId: "worker12345678",
      dockerName: "worker",
      image: "busybox",
      lastKnownStatus: "stopped",
      isActive: true
    }
  });
  const api = await prisma.container.create({
    data: {
      nodeId: node2.id,
      dockerContainerId: "api9876543210",
      dockerName: "api",
      image: "node:22-alpine",
      lastKnownStatus: "running",
      isActive: true
    }
  });

  // Project for client A on node1 with the web container.
  const projectA = await prisma.project.create({
    data: {
      name: "Web Stack",
      slug: `web-stack-${suffix}`,
      clientAccountId: clientA.id,
      nodeId: node1.id,
      isActive: true
    }
  });
  await prisma.container.update({
    where: { id: web.id },
    data: { projectId: projectA.id }
  });

  // Grants:
  //  - client A: project-level grant on Web Stack (start/stop/restart)
  //  - client A: container-level grant on worker (view_logs only)
  //  - client B: container-level grant on api (start/stop/restart)
  await prisma.accessGrant.create({
    data: {
      clientAccountId: clientA.id,
      nodeId: node1.id,
      projectId: projectA.id,
      allowedActions: ["start", "stop", "restart"],
      isActive: true
    }
  });
  const workerGrant = await prisma.accessGrant.create({
    data: {
      clientAccountId: clientA.id,
      nodeId: node1.id,
      containerId: worker.id,
      allowedActions: ["view_logs"],
      isActive: true
    }
  });
  await prisma.accessGrant.create({
    data: {
      clientAccountId: clientB.id,
      nodeId: node2.id,
      containerId: api.id,
      allowedActions: ["start", "stop", "restart"],
      isActive: true
    }
  });

  // Legacy pre-refactor assignment for client B (like the migrated rows in prod).
  const legacyBAssignment = await prisma.containerAssignment.create({
    data: {
      clientAccountId: clientB.id,
      nodeId: node2.id,
      containerId: api.id,
      dockerContainerId: api.dockerContainerId,
      dockerName: "api",
      image: "node:22-alpine",
      allowedActions: ["start", "stop", "restart"],
      isActive: true
    }
  });

  return {
    clientA,
    clientB,
    legacyBAssignment,
    node1,
    node2,
    adminA,
    clientAAdmin,
    clientAOperator,
    clientAViewer,
    clientBOperator,
    web,
    worker,
    api,
    projectA,
    workerGrant,
    password
  };
}

/** Build a fake AuthSession for a user row (bypasses cookie machinery). */
export function sessionFor(user: {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  clientAccountId: string | null;
  clientAccount?: { name: string } | null;
}): AuthSession {
  return {
    sessionId: `session-${user.id}`,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    clientAccountId: user.clientAccountId,
    clientAccountName: user.clientAccount?.name ?? null
  };
}
