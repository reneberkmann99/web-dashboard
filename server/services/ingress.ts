import net from "node:net";
import { Prisma, type IngressExposureType, type PublicAddressAllocation, type IngressProviderKind, type IngressEndpointStatus } from "@prisma/client";
import { lockClientAccountForQuota, lockPublicAddressForUpdate, prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import type { AuthSession } from "@/server/auth/session";

/**
 * Ingress (Phase 5): PublicAddress and IngressProvider are platform-owned —
 * only ADMIN may manage them (organization users must never see platform
 * Public Address / Provider management, brief). IngressEndpoint is
 * organization-scoped, same tenant-isolation pattern as
 * server/services/notifications.ts and server/services/domains.ts.
 *
 * Architecture invariant this file enforces: an IngressEndpoint's identity
 * (id, hostname via Domain, publicPort) is independent of which node the
 * target workload currently runs on. The model has no "node" field at all —
 * the chain is public endpoint -> PublicAddress/IngressProvider -> current
 * workload backend, never node WAN IP -> Docker host port. Relocating a
 * workload to a different node never touches this table.
 */

export class IngressForbiddenError extends Error {
  constructor(message = "FORBIDDEN") {
    super(message);
    this.name = "IngressForbiddenError";
  }
}

// ---------------------------------------------------------------------------
// Platform-only: Public Addresses
// ---------------------------------------------------------------------------

function requirePlatformAdmin(actor: AuthSession): void {
  if (actor.role !== "ADMIN") throw new IngressForbiddenError();
}

function isValidIpForVersion(ipAddress: string, ipVersion: "V4" | "V6"): boolean {
  return ipVersion === "V4" ? net.isIPv4(ipAddress) : net.isIPv6(ipAddress);
}

/**
 * IPv6 has many equivalent textual spellings of the same address (leading
 * zeros, `::` compression, case) — without canonicalizing before storage,
 * two different spellings of the identical real address could create two
 * PublicAddress rows, each independently reserving the same real
 * IP/port/protocol tuple (port-conflict detection keys off publicAddressId,
 * not the underlying IP), silently defeating both address uniqueness and
 * TCP/UDP conflict detection. The WHATWG URL host parser normalizes this
 * (compresses zero runs, lowercases hex) far more reliably than a hand-rolled
 * normalizer. IPv4 has no equivalent ambiguity once `net.isIPv4` accepts it.
 */
function canonicalizeIpAddress(ipAddress: string, ipVersion: "V4" | "V6"): string {
  if (ipVersion === "V4") return ipAddress.trim();
  // Zone-id addresses (fe80::1%eth0) pass net.isIPv6 but are link-local
  // scoped, never a real public WAN address, and the URL parser rejects
  // them — treat that rejection as an invalid address, same as any other.
  try {
    return new URL(`http://[${ipAddress.trim()}]`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new Error("INVALID_IP_ADDRESS");
  }
}

const publicAddressSelect = {
  id: true,
  label: true,
  ipAddress: true,
  ipVersion: true,
  allocation: true,
  enabled: true,
  reservedForOrgId: true,
  reservedForOrg: { select: { id: true, name: true } },
  providerId: true,
  provider: { select: { id: true, name: true, kind: true } },
  createdAt: true,
  updatedAt: true
} satisfies Prisma.PublicAddressSelect;

export type CreatePublicAddressInput = {
  label: string;
  ipAddress: string;
  ipVersion: "V4" | "V6";
  allocation?: PublicAddressAllocation;
  enabled?: boolean;
  reservedForOrgId?: string | null;
  providerId?: string | null;
  actor: AuthSession;
  sourceIp?: string | null;
};

export async function createPublicAddress(input: CreatePublicAddressInput) {
  requirePlatformAdmin(input.actor);
  if (!isValidIpForVersion(input.ipAddress, input.ipVersion)) throw new Error("INVALID_IP_ADDRESS");
  const ipAddress = canonicalizeIpAddress(input.ipAddress, input.ipVersion);
  const allocation = input.allocation ?? "SHARED";
  if (allocation === "SHARED" && input.reservedForOrgId) throw new Error("SHARED_ADDRESS_CANNOT_BE_RESERVED");
  if (input.providerId) await assertProviderExists(input.providerId);

  // The row lock serializes concurrent quota checks for this organization —
  // without it, two concurrent requests with one dedicated-IP slot
  // remaining could both observe headroom and both insert.
  const address = await prisma.$transaction(async (tx) => {
    if (allocation === "DEDICATED" && input.reservedForOrgId) {
      await lockClientAccountForQuota(tx, input.reservedForOrgId);
      await assertDedicatedIpQuota(tx, input.reservedForOrgId);
    }
    return tx.publicAddress.create({
      data: {
        label: input.label.trim(),
        ipAddress,
        ipVersion: input.ipVersion,
        allocation,
        enabled: input.enabled ?? true,
        reservedForOrgId: allocation === "DEDICATED" ? (input.reservedForOrgId ?? null) : null,
        providerId: input.providerId ?? null
      },
      select: publicAddressSelect
    });
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "PUBLIC_ADDRESS_CREATED",
    targetType: "PUBLIC_ADDRESS",
    targetId: address.id,
    metadata: { label: address.label, ipAddress: address.ipAddress, allocation: address.allocation },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return address;
}

async function assertDedicatedIpQuota(tx: Prisma.TransactionClient, clientAccountId: string): Promise<void> {
  const account = await tx.clientAccount.findUnique({ where: { id: clientAccountId }, select: { id: true, maxDedicatedIps: true } });
  if (!account) throw new Error("NOT_FOUND");
  if (account.maxDedicatedIps === null) return;
  const existing = await tx.publicAddress.count({ where: { reservedForOrgId: clientAccountId, allocation: "DEDICATED" } });
  if (existing >= account.maxDedicatedIps) throw new Error("DEDICATED_IP_QUOTA_EXCEEDED");
}

/**
 * A DEDICATED reservation claims a PublicAddress as exclusive to one
 * organization. If other organizations already have live IngressEndpoints
 * bound to this address (e.g. it started SHARED and served several tenants),
 * reserving it out from under them would misrepresent it as exclusive while
 * still carrying cross-organization bindings — reject instead.
 */
async function assertNoConflictingEndpointOwners(tx: Prisma.TransactionClient, publicAddressId: string, reservedForOrgId: string): Promise<void> {
  const foreignEndpoint = await tx.ingressEndpoint.findFirst({
    where: { publicAddressId, clientAccountId: { not: reservedForOrgId } },
    select: { id: true }
  });
  if (foreignEndpoint) throw new Error("RESERVATION_CONFLICTS_WITH_EXISTING_ENDPOINTS");
}

async function assertProviderExists(providerId: string): Promise<void> {
  const provider = await prisma.ingressProvider.findUnique({ where: { id: providerId }, select: { id: true } });
  if (!provider) throw new Error("NOT_FOUND");
}

/**
 * A disabled provider must never be freshly bound to an IngressEndpoint —
 * whether explicitly chosen or inherited from a PublicAddress — on create
 * OR update, otherwise the provider's own Disable action has no effect on
 * new/changed bindings.
 */
async function assertProviderUsable(client: Prisma.TransactionClient | typeof prisma, providerId: string): Promise<void> {
  const provider = await client.ingressProvider.findUnique({ where: { id: providerId }, select: { id: true, enabled: true } });
  if (!provider || !provider.enabled) throw new Error("INGRESS_PROVIDER_UNAVAILABLE");
}

/** ADMIN-only full management view (every address, including reservation/provider detail). */
export async function listPublicAddresses(actor: AuthSession) {
  requirePlatformAdmin(actor);
  return prisma.publicAddress.findMany({ orderBy: { label: "asc" }, select: publicAddressSelect });
}

/**
 * Client-safe picker: only what an organization is allowed to bind an
 * IngressEndpoint to (enabled, and either SHARED or DEDICATED-to-them) — no
 * other organization's reservation or platform inventory is exposed.
 */
export async function listAvailablePublicAddressesForOrg(clientAccountId: string) {
  return prisma.publicAddress.findMany({
    where: { enabled: true, OR: [{ allocation: "SHARED" }, { reservedForOrgId: clientAccountId }] },
    orderBy: { label: "asc" },
    select: { id: true, label: true, ipAddress: true, ipVersion: true, allocation: true }
  });
}

export type UpdatePublicAddressInput = {
  id: string;
  label?: string;
  enabled?: boolean;
  allocation?: PublicAddressAllocation;
  reservedForOrgId?: string | null;
  providerId?: string | null;
  actor: AuthSession;
  sourceIp?: string | null;
};

export async function updatePublicAddress(input: UpdatePublicAddressInput) {
  requirePlatformAdmin(input.actor);
  const existsCheck = await prisma.publicAddress.findUnique({ where: { id: input.id }, select: { id: true } });
  if (!existsCheck) throw new Error("NOT_FOUND");
  if (input.providerId) await assertProviderExists(input.providerId);

  const address = await prisma.$transaction(async (tx) => {
    // Lock the address FIRST (consistent order with createIngressEndpoint —
    // see server/db.ts's lockPublicAddressForUpdate doc comment), then
    // re-read it under that lock rather than reusing the pre-transaction
    // snapshot above: deriving allocation/reservedForOrgId from a stale read
    // can silently reinstate a reservation a concurrent update already
    // cleared (or vice versa) once this transaction's own write lands.
    await lockPublicAddressForUpdate(tx, input.id);
    const existing = await tx.publicAddress.findUniqueOrThrow({ where: { id: input.id } });

    const allocation = input.allocation ?? existing.allocation;
    const reservedForOrgId = input.reservedForOrgId !== undefined ? input.reservedForOrgId : existing.reservedForOrgId;
    if (allocation === "SHARED" && reservedForOrgId) throw new Error("SHARED_ADDRESS_CANNOT_BE_RESERVED");

    if (reservedForOrgId && reservedForOrgId !== existing.reservedForOrgId) {
      await lockClientAccountForQuota(tx, reservedForOrgId);
      if (allocation === "DEDICATED") await assertDedicatedIpQuota(tx, reservedForOrgId);
      await assertNoConflictingEndpointOwners(tx, existing.id, reservedForOrgId);
    }

    return tx.publicAddress.update({
      where: { id: input.id },
      data: {
        label: input.label?.trim(),
        enabled: input.enabled,
        allocation: input.allocation,
        reservedForOrgId: allocation === "SHARED" ? null : reservedForOrgId,
        providerId: input.providerId
      },
      select: publicAddressSelect
    });
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "PUBLIC_ADDRESS_UPDATED",
    targetType: "PUBLIC_ADDRESS",
    targetId: address.id,
    metadata: { label: address.label, enabled: address.enabled, allocation: address.allocation },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return address;
}

export async function deletePublicAddress(input: { id: string; actor: AuthSession; sourceIp?: string | null }): Promise<void> {
  requirePlatformAdmin(input.actor);
  const existing = await prisma.publicAddress.findUnique({
    where: { id: input.id },
    select: { id: true, label: true, _count: { select: { ingressEndpoints: true } } }
  });
  if (!existing) throw new Error("NOT_FOUND");
  if (existing._count.ingressEndpoints > 0) throw new Error("PUBLIC_ADDRESS_IN_USE");

  await prisma.publicAddress.delete({ where: { id: input.id } });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "PUBLIC_ADDRESS_DELETED",
    targetType: "PUBLIC_ADDRESS",
    targetId: input.id,
    metadata: { label: existing.label },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
}

// ---------------------------------------------------------------------------
// Platform-only: Ingress Providers
// ---------------------------------------------------------------------------

const providerSelect = {
  id: true,
  name: true,
  kind: true,
  enabled: true,
  gatewayHostname: true,
  config: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.IngressProviderSelect;

export type CreateIngressProviderInput = {
  name: string;
  kind?: IngressProviderKind;
  enabled?: boolean;
  gatewayHostname?: string | null;
  config?: Record<string, unknown> | null;
  actor: AuthSession;
  sourceIp?: string | null;
};

export async function createIngressProvider(input: CreateIngressProviderInput) {
  requirePlatformAdmin(input.actor);
  const provider = await prisma.ingressProvider.create({
    data: {
      name: input.name.trim(),
      kind: input.kind ?? "MANUAL",
      enabled: input.enabled ?? true,
      gatewayHostname: input.gatewayHostname ?? null,
      config: (input.config ?? Prisma.JsonNull) as Prisma.InputJsonValue
    },
    select: providerSelect
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "INGRESS_PROVIDER_CREATED",
    targetType: "INGRESS_PROVIDER",
    targetId: provider.id,
    metadata: { name: provider.name, kind: provider.kind },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return provider;
}

export async function listIngressProviders(actor: AuthSession) {
  requirePlatformAdmin(actor);
  return prisma.ingressProvider.findMany({ orderBy: { name: "asc" }, select: providerSelect });
}

export type UpdateIngressProviderInput = {
  id: string;
  name?: string;
  enabled?: boolean;
  gatewayHostname?: string | null;
  config?: Record<string, unknown> | null;
  actor: AuthSession;
  sourceIp?: string | null;
};

export async function updateIngressProvider(input: UpdateIngressProviderInput) {
  requirePlatformAdmin(input.actor);
  const existing = await prisma.ingressProvider.findUnique({ where: { id: input.id }, select: { id: true } });
  if (!existing) throw new Error("NOT_FOUND");

  const provider = await prisma.ingressProvider.update({
    where: { id: input.id },
    data: {
      name: input.name?.trim(),
      enabled: input.enabled,
      gatewayHostname: input.gatewayHostname,
      config: input.config === undefined ? undefined : ((input.config ?? Prisma.JsonNull) as Prisma.InputJsonValue)
    },
    select: providerSelect
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "INGRESS_PROVIDER_UPDATED",
    targetType: "INGRESS_PROVIDER",
    targetId: provider.id,
    metadata: { name: provider.name, enabled: provider.enabled },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return provider;
}

export async function deleteIngressProvider(input: { id: string; actor: AuthSession; sourceIp?: string | null }): Promise<void> {
  requirePlatformAdmin(input.actor);
  const existing = await prisma.ingressProvider.findUnique({
    where: { id: input.id },
    select: { id: true, name: true, _count: { select: { publicAddresses: true, ingressEndpoints: true } } }
  });
  if (!existing) throw new Error("NOT_FOUND");
  if (existing._count.publicAddresses > 0 || existing._count.ingressEndpoints > 0) throw new Error("INGRESS_PROVIDER_IN_USE");

  await prisma.ingressProvider.delete({ where: { id: input.id } });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "INGRESS_PROVIDER_DELETED",
    targetType: "INGRESS_PROVIDER",
    targetId: input.id,
    metadata: { name: existing.name },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
}

// ---------------------------------------------------------------------------
// Ingress Endpoints (organization-scoped)
// ---------------------------------------------------------------------------

function requireIngressViewActor(actor: AuthSession): void {
  if (actor.role === "ADMIN") return;
  if (!actor.clientAccountId) throw new IngressForbiddenError();
}

function requireIngressManageActor(actor: AuthSession): void {
  if (actor.role === "ADMIN") return;
  if (actor.role !== "CLIENT_ADMIN" || !actor.clientAccountId) throw new IngressForbiddenError();
}

function tenantScopeFor(actor: AuthSession): string | null {
  return actor.role === "ADMIN" ? null : actor.clientAccountId!;
}

function assertOwnsClientAccountId(actor: AuthSession, ownerId: string): void {
  if (actor.role === "ADMIN") return;
  if (ownerId !== actor.clientAccountId) throw new IngressForbiddenError();
}

const isTcpUdp = (exposureType: IngressExposureType): boolean => exposureType === "TCP" || exposureType === "UDP";

const ingressEndpointSelect = {
  id: true,
  clientAccountId: true,
  clientAccount: { select: { id: true, name: true } },
  workloadId: true,
  workload: { select: { id: true, name: true, nodeId: true } },
  containerId: true,
  container: { select: { id: true, dockerName: true } },
  serviceName: true,
  targetPort: true,
  exposureType: true,
  domainId: true,
  domain: { select: { id: true, hostname: true, status: true } },
  publicAddressId: true,
  publicAddress: { select: { id: true, label: true, ipAddress: true, ipVersion: true, allocation: true } },
  publicPort: true,
  providerId: true,
  provider: { select: { id: true, name: true, kind: true } },
  status: true,
  statusDetail: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.IngressEndpointSelect;

/**
 * Detects whether (publicAddressId, publicPort, exposureType) is already
 * reserved by another endpoint. Only meaningful for TCP/UDP — HTTP/HTTPS
 * endpoints never set publicPort, so they're never in contention here (a
 * shared PublicAddress on 443 can host any number of them, distinguished by
 * hostname/SNI at the gateway, not by this table).
 */
export async function checkIngressPortConflict(
  input: {
    publicAddressId: string;
    publicPort: number;
    exposureType: IngressExposureType;
    excludeId?: string;
  },
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<boolean> {
  const conflict = await client.ingressEndpoint.findFirst({
    where: {
      publicAddressId: input.publicAddressId,
      publicPort: input.publicPort,
      exposureType: input.exposureType,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {})
    },
    select: { id: true }
  });
  return Boolean(conflict);
}

const HTTP_IMPLIED_PORT: Record<"HTTP" | "HTTPS", number> = { HTTP: 80, HTTPS: 443 };

/**
 * HTTP/HTTPS endpoints never set publicPort (checkIngressPortConflict alone
 * never sees them), but at the actual gateway they still occupy the
 * conventional TCP/80 or TCP/443 socket on their PublicAddress via SNI/vhost
 * routing — a raw TCP endpoint explicitly requesting that same port can't
 * bind it too, and a new HTTP(S) endpoint can't be created where a raw TCP
 * endpoint already claims its conventional port. Two HTTP(S) endpoints on
 * the same address never conflict with EACH OTHER (that's exactly what
 * SNI/vhost routing exists for) — this only ever checks against TCP rows.
 */
async function checkHttpListenerConflict(
  client: Prisma.TransactionClient | typeof prisma,
  input: { publicAddressId: string; exposureType: IngressExposureType; publicPort: number | null; excludeId?: string }
): Promise<boolean> {
  let conflictWhere: { exposureType: IngressExposureType; publicPort?: number };
  if (input.exposureType === "TCP" && input.publicPort !== null) {
    const impliedType = input.publicPort === HTTP_IMPLIED_PORT.HTTP ? "HTTP" : input.publicPort === HTTP_IMPLIED_PORT.HTTPS ? "HTTPS" : null;
    if (!impliedType) return false;
    conflictWhere = { exposureType: impliedType };
  } else if (input.exposureType === "HTTP" || input.exposureType === "HTTPS") {
    conflictWhere = { exposureType: "TCP", publicPort: HTTP_IMPLIED_PORT[input.exposureType] };
  } else {
    return false;
  }
  const conflict = await client.ingressEndpoint.findFirst({
    where: { publicAddressId: input.publicAddressId, ...conflictWhere, ...(input.excludeId ? { id: { not: input.excludeId } } : {}) },
    select: { id: true }
  });
  return Boolean(conflict);
}

export type CreateIngressEndpointInput = {
  clientAccountId?: string | null;
  workloadId: string;
  containerId?: string | null;
  serviceName?: string | null;
  targetPort: number;
  exposureType: IngressExposureType;
  domainId?: string | null;
  publicAddressId: string;
  publicPort?: number | null;
  providerId?: string | null;
  actor: AuthSession;
  sourceIp?: string | null;
};

export async function createIngressEndpoint(input: CreateIngressEndpointInput) {
  requireIngressManageActor(input.actor);
  const clientAccountId = input.actor.role === "ADMIN" ? input.clientAccountId : input.actor.clientAccountId!;
  if (!clientAccountId) throw new Error("ORGANIZATION_REQUIRED");

  const account = await prisma.clientAccount.findUnique({
    where: { id: clientAccountId },
    select: { id: true, maxIngressEndpoints: true, maxTcpUdpEndpoints: true }
  });
  if (!account) throw new Error("NOT_FOUND");

  // The workload (and, if given, the container) must belong to this exact
  // organization — never trust the client to only submit its own ids. A
  // deactivated workload (server/services/workload-lifecycle.ts) or a
  // deleted (soft: isActive false, server/services/container-lifecycle.ts)
  // container can never back an endpoint — a stale picker submission or a
  // direct API call must not be able to bind to something the platform
  // considers inactive.
  const workload = await prisma.project.findUnique({ where: { id: input.workloadId }, select: { id: true, clientAccountId: true, isActive: true } });
  if (!workload || workload.clientAccountId !== clientAccountId || !workload.isActive) throw new Error("NOT_FOUND");
  if (input.containerId) {
    const container = await prisma.container.findUnique({ where: { id: input.containerId }, select: { id: true, projectId: true, isActive: true } });
    if (!container || container.projectId !== input.workloadId || !container.isActive) throw new Error("NOT_FOUND");
  }

  const tcpUdp = isTcpUdp(input.exposureType);

  let domainId: string | null = null;
  if (tcpUdp) {
    if (input.domainId) throw new Error("TCP_UDP_ENDPOINT_CANNOT_HAVE_DOMAIN");
    if (!input.publicPort) throw new Error("PUBLIC_PORT_REQUIRED");
  } else {
    if (!input.domainId) throw new Error("DOMAIN_REQUIRED");
    if (input.publicPort) throw new Error("HTTP_ENDPOINT_CANNOT_SET_PUBLIC_PORT");
    const domain = await prisma.domain.findUnique({ where: { id: input.domainId }, select: { id: true, clientAccountId: true, status: true, ingressEndpoints: { select: { id: true } } } });
    if (!domain || domain.clientAccountId !== clientAccountId) throw new Error("NOT_FOUND");
    if (domain.status !== "VERIFIED") throw new Error("DOMAIN_NOT_VERIFIED");
    if (domain.ingressEndpoints.length > 0) throw new Error("DOMAIN_ALREADY_BOUND");
    domainId = domain.id;
  }

  if (!input.containerId && !input.serviceName) throw new Error("BACKEND_IDENTIFIER_REQUIRED");

  // The row locks serialize this against both a concurrent updatePublicAddress
  // reservation change (without the PublicAddress lock, acquired FIRST for
  // consistency with that function — see server/db.ts's
  // lockPublicAddressForUpdate doc comment — and re-reading it under that
  // lock, this could still bind to an address an admin is simultaneously
  // reserving to a different organization) and concurrent quota checks for
  // this organization (maxIngressEndpoints/maxTcpUdpEndpoints — without the
  // ClientAccount lock, two concurrent requests with one slot remaining
  // could both observe headroom and both insert). The port-conflict check
  // runs in here too (consistent read within the same transaction); it's
  // additionally backstopped by the table's own unique constraint regardless.
  let endpoint;
  try {
    endpoint = await prisma.$transaction(async (tx) => {
      await lockPublicAddressForUpdate(tx, input.publicAddressId);

      const publicAddress = await tx.publicAddress.findUnique({ where: { id: input.publicAddressId } });
      if (!publicAddress || !publicAddress.enabled) throw new Error("PUBLIC_ADDRESS_UNAVAILABLE");
      if (publicAddress.allocation === "DEDICATED" && publicAddress.reservedForOrgId !== clientAccountId) {
        throw new Error("PUBLIC_ADDRESS_RESERVED");
      }

      // A disabled provider must never be freshly bound to — whether
      // explicitly chosen or inherited from the address — otherwise the
      // provider's own Disable action has no effect on new bindings.
      const resolvedProviderId = input.providerId ?? publicAddress.providerId ?? null;
      if (resolvedProviderId) await assertProviderUsable(tx, resolvedProviderId);

      await lockClientAccountForQuota(tx, clientAccountId);

      if (tcpUdp) {
        const totalExisting = await tx.ingressEndpoint.count({ where: { clientAccountId, exposureType: { in: ["TCP", "UDP"] } } });
        if (account.maxTcpUdpEndpoints !== null && totalExisting >= account.maxTcpUdpEndpoints) {
          throw new Error("TCP_UDP_ENDPOINT_QUOTA_EXCEEDED");
        }
        if (await checkIngressPortConflict({ publicAddressId: input.publicAddressId, publicPort: input.publicPort!, exposureType: input.exposureType }, tx)) {
          throw new Error("PORT_CONFLICT");
        }
      }
      if (await checkHttpListenerConflict(tx, { publicAddressId: input.publicAddressId, exposureType: input.exposureType, publicPort: tcpUdp ? input.publicPort! : null })) {
        throw new Error("PORT_CONFLICT");
      }

      if (account.maxIngressEndpoints !== null) {
        const totalExisting = await tx.ingressEndpoint.count({ where: { clientAccountId } });
        if (totalExisting >= account.maxIngressEndpoints) throw new Error("INGRESS_ENDPOINT_QUOTA_EXCEEDED");
      }

      return tx.ingressEndpoint.create({
        data: {
          clientAccountId,
          workloadId: input.workloadId,
          containerId: input.containerId ?? null,
          serviceName: input.serviceName ?? null,
          targetPort: input.targetPort,
          exposureType: input.exposureType,
          domainId,
          publicAddressId: input.publicAddressId,
          publicPort: tcpUdp ? input.publicPort! : null,
          providerId: resolvedProviderId,
          createdById: input.actor.userId
        },
        select: ingressEndpointSelect
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // DB-level backstop for a race between the pre-check above and this
      // insert (see model comment on IngressEndpoint's unique constraint).
      throw new Error(tcpUdp ? "PORT_CONFLICT" : "DOMAIN_ALREADY_BOUND");
    }
    throw error;
  }

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    clientAccountId,
    action: "INGRESS_ENDPOINT_CREATED",
    targetType: "INGRESS_ENDPOINT",
    targetId: endpoint.id,
    metadata: { workloadId: endpoint.workloadId, exposureType: endpoint.exposureType, publicPort: endpoint.publicPort, domainId: endpoint.domainId },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return endpoint;
}

export async function listIngressEndpoints(actor: AuthSession, filters?: { workloadId?: string }) {
  requireIngressViewActor(actor);
  const scope = tenantScopeFor(actor);
  return prisma.ingressEndpoint.findMany({
    where: {
      ...(scope ? { clientAccountId: scope } : {}),
      ...(filters?.workloadId ? { workloadId: filters.workloadId } : {})
    },
    orderBy: { createdAt: "desc" },
    select: ingressEndpointSelect
  });
}

export async function getIngressEndpoint(id: string, actor: AuthSession) {
  requireIngressViewActor(actor);
  const endpoint = await prisma.ingressEndpoint.findUnique({ where: { id }, select: ingressEndpointSelect });
  if (!endpoint) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(actor, endpoint.clientAccountId);
  return endpoint;
}

export type UpdateIngressEndpointInput = {
  id: string;
  containerId?: string | null;
  serviceName?: string | null;
  targetPort?: number;
  providerId?: string | null;
  status?: IngressEndpointStatus;
  statusDetail?: string | null;
  actor: AuthSession;
  sourceIp?: string | null;
};

/**
 * Deliberately does NOT accept workloadId, domainId, publicAddressId, or
 * publicPort — changing what an endpoint targets or which public
 * address/port it reserves is a new binding decision (delete + recreate),
 * not an edit. This is also what keeps the endpoint's public identity
 * stable across a workload relocating to a different node: nothing here can
 * touch the node, and nothing here can touch the hostname/port an operator
 * has already published.
 */
export async function updateIngressEndpoint(input: UpdateIngressEndpointInput) {
  requireIngressManageActor(input.actor);
  const existing = await prisma.ingressEndpoint.findUnique({ where: { id: input.id } });
  if (!existing) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, existing.clientAccountId);

  if (input.containerId) {
    const container = await prisma.container.findUnique({ where: { id: input.containerId }, select: { id: true, projectId: true, isActive: true } });
    if (!container || container.projectId !== existing.workloadId || !container.isActive) throw new Error("NOT_FOUND");
  }

  // An endpoint with neither a container nor a service name has nothing for
  // a gateway to route to — reject a patch that would leave it that way,
  // same as create.
  const resultingContainerId = input.containerId !== undefined ? input.containerId : existing.containerId;
  const resultingServiceName = input.serviceName !== undefined ? input.serviceName : existing.serviceName;
  if (!resultingContainerId && !resultingServiceName) throw new Error("BACKEND_IDENTIFIER_REQUIRED");

  if (input.providerId) await assertProviderUsable(prisma, input.providerId);

  const endpoint = await prisma.ingressEndpoint.update({
    where: { id: input.id },
    data: {
      containerId: input.containerId,
      serviceName: input.serviceName,
      targetPort: input.targetPort,
      providerId: input.providerId,
      status: input.status,
      statusDetail: input.statusDetail
    },
    select: ingressEndpointSelect
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    clientAccountId: endpoint.clientAccountId,
    action: "INGRESS_ENDPOINT_UPDATED",
    targetType: "INGRESS_ENDPOINT",
    targetId: endpoint.id,
    metadata: { status: endpoint.status },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return endpoint;
}

export async function deleteIngressEndpoint(input: { id: string; actor: AuthSession; sourceIp?: string | null }): Promise<void> {
  requireIngressManageActor(input.actor);
  const existing = await prisma.ingressEndpoint.findUnique({ where: { id: input.id }, select: { id: true, clientAccountId: true } });
  if (!existing) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, existing.clientAccountId);

  await prisma.ingressEndpoint.delete({ where: { id: input.id } });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    clientAccountId: existing.clientAccountId,
    action: "INGRESS_ENDPOINT_DELETED",
    targetType: "INGRESS_ENDPOINT",
    targetId: input.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
}
