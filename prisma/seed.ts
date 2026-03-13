import { PrismaClient, Role } from "@prisma/client";
import { hashPassword } from "../server/auth/password";
import { encryptSecret } from "../server/security/crypto";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@hostpanel.local";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const clientPassword = process.env.SEED_CLIENT_PASSWORD ?? "ClientPass123!";

  const [clientAlpha, clientBeta] = await Promise.all([
    prisma.clientAccount.upsert({
      where: { slug: "acme-hosting" },
      update: { name: "Acme Hosting" },
      create: { name: "Acme Hosting", slug: "acme-hosting" }
    }),
    prisma.clientAccount.upsert({
      where: { slug: "northstar-labs" },
      update: { name: "Northstar Labs" },
      create: { name: "Northstar Labs", slug: "northstar-labs" }
    })
  ]);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      displayName: "HostPanel Admin",
      role: Role.ADMIN,
      isActive: true,
      passwordHash: await hashPassword(adminPassword)
    },
    create: {
      email: adminEmail,
      displayName: "HostPanel Admin",
      role: Role.ADMIN,
      isActive: true,
      passwordHash: await hashPassword(adminPassword)
    }
  });

  await prisma.user.upsert({
    where: { email: "ops@acme-hosting.local" },
    update: {
      displayName: "Acme Ops",
      role: Role.CLIENT,
      clientAccountId: clientAlpha.id,
      isActive: true,
      passwordHash: await hashPassword(clientPassword)
    },
    create: {
      email: "ops@acme-hosting.local",
      displayName: "Acme Ops",
      role: Role.CLIENT,
      clientAccountId: clientAlpha.id,
      isActive: true,
      passwordHash: await hashPassword(clientPassword)
    }
  });

  await prisma.user.upsert({
    where: { email: "dev@northstar-labs.local" },
    update: {
      displayName: "Northstar Dev",
      role: Role.CLIENT,
      clientAccountId: clientBeta.id,
      isActive: true,
      passwordHash: await hashPassword(clientPassword)
    },
    create: {
      email: "dev@northstar-labs.local",
      displayName: "Northstar Dev",
      role: Role.CLIENT,
      clientAccountId: clientBeta.id,
      isActive: true,
      passwordHash: await hashPassword(clientPassword)
    }
  });

  const [nodeA, nodeB] = await Promise.all([
    prisma.node.upsert({
      where: { hostname: "node-a.local" },
      update: {
        name: "Node A",
        apiBaseUrl: "http://127.0.0.1:8081",
        apiKeyEncrypted: encryptSecret(process.env.AGENT_API_KEY ?? "agent-dev-key"),
        isActive: true
      },
      create: {
        name: "Node A",
        hostname: "node-a.local",
        apiBaseUrl: "http://127.0.0.1:8081",
        apiKeyEncrypted: encryptSecret(process.env.AGENT_API_KEY ?? "agent-dev-key"),
        status: "UNKNOWN",
        isActive: true
      }
    }),
    prisma.node.upsert({
      where: { hostname: "node-b.local" },
      update: {
        name: "Node B",
        apiBaseUrl: "http://127.0.0.1:8081",
        apiKeyEncrypted: encryptSecret(process.env.AGENT_API_KEY ?? "agent-dev-key"),
        isActive: true
      },
      create: {
        name: "Node B",
        hostname: "node-b.local",
        apiBaseUrl: "http://127.0.0.1:8081",
        apiKeyEncrypted: encryptSecret(process.env.AGENT_API_KEY ?? "agent-dev-key"),
        status: "UNKNOWN",
        isActive: true
      }
    })
  ]);

  const [projectA, projectB] = await Promise.all([
    prisma.project.upsert({
      where: { clientAccountId_slug: { clientAccountId: clientAlpha.id, slug: "main-app" } },
      update: { name: "Main App", nodeId: nodeA.id },
      create: {
        name: "Main App",
        slug: "main-app",
        clientAccountId: clientAlpha.id,
        nodeId: nodeA.id,
        description: "Primary web stack"
      }
    }),
    prisma.project.upsert({
      where: { clientAccountId_slug: { clientAccountId: clientBeta.id, slug: "api-suite" } },
      update: { name: "API Suite", nodeId: nodeB.id },
      create: {
        name: "API Suite",
        slug: "api-suite",
        clientAccountId: clientBeta.id,
        nodeId: nodeB.id,
        description: "Backend services"
      }
    })
  ]);

  await prisma.containerAssignment.upsert({
    where: {
      nodeId_dockerContainerId: {
        nodeId: nodeA.id,
        dockerContainerId: "acme-web-1"
      }
    },
    update: {
      clientAccountId: clientAlpha.id,
      projectId: projectA.id,
      dockerName: "acme-web",
      image: "ghcr.io/acme/web:latest",
      friendlyLabel: "Acme Web"
    },
    create: {
      clientAccountId: clientAlpha.id,
      projectId: projectA.id,
      nodeId: nodeA.id,
      dockerContainerId: "acme-web-1",
      dockerName: "acme-web",
      image: "ghcr.io/acme/web:latest",
      friendlyLabel: "Acme Web"
    }
  });

  await prisma.containerAssignment.upsert({
    where: {
      nodeId_dockerContainerId: {
        nodeId: nodeA.id,
        dockerContainerId: "acme-worker-1"
      }
    },
    update: {
      clientAccountId: clientAlpha.id,
      projectId: projectA.id,
      dockerName: "acme-worker",
      image: "ghcr.io/acme/worker:latest",
      friendlyLabel: "Acme Worker"
    },
    create: {
      clientAccountId: clientAlpha.id,
      projectId: projectA.id,
      nodeId: nodeA.id,
      dockerContainerId: "acme-worker-1",
      dockerName: "acme-worker",
      image: "ghcr.io/acme/worker:latest",
      friendlyLabel: "Acme Worker"
    }
  });

  await prisma.containerAssignment.upsert({
    where: {
      nodeId_dockerContainerId: {
        nodeId: nodeB.id,
        dockerContainerId: "northstar-api-1"
      }
    },
    update: {
      clientAccountId: clientBeta.id,
      projectId: projectB.id,
      dockerName: "northstar-api",
      image: "ghcr.io/northstar/api:stable",
      friendlyLabel: "Northstar API"
    },
    create: {
      clientAccountId: clientBeta.id,
      projectId: projectB.id,
      nodeId: nodeB.id,
      dockerContainerId: "northstar-api-1",
      dockerName: "northstar-api",
      image: "ghcr.io/northstar/api:stable",
      friendlyLabel: "Northstar API"
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
