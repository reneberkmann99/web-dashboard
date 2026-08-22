import crypto from "node:crypto";
import dns from "node:dns/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import type { AuthSession } from "@/server/auth/session";

/**
 * Domains (Phase 5): organization-owned hostnames, verified by DNS before an
 * IngressEndpoint may bind them. Noderaft never claims to control DNS — it
 * only checks it, and only ever reports what the last check observed.
 *
 * Tenant isolation follows the same pattern as server/services/notifications.ts:
 * every mutating/listing function takes the caller's `actor` and, for a
 * non-ADMIN actor, hard-scopes reads to their own organization and forces
 * writes onto their own `clientAccountId` — never trust a client-supplied
 * clientAccountId.
 */

export class DomainForbiddenError extends Error {
  constructor(message = "FORBIDDEN") {
    super(message);
    this.name = "DomainForbiddenError";
  }
}

const CHALLENGE_LABEL = "_noderaft-challenge";
const TXT_VALUE_PREFIX = "noderaft-domain-verification=";

export function challengeHostname(hostname: string): string {
  return `${CHALLENGE_LABEL}.${hostname}`;
}

export function verificationTxtValue(token: string): string {
  return `${TXT_VALUE_PREFIX}${token}`;
}

function generateVerificationToken(): string {
  return crypto.randomBytes(20).toString("hex");
}

// ---------------------------------------------------------------------------
// DNS resolution seam (test-only override — application code always uses the
// real Node resolver through this one function).
// ---------------------------------------------------------------------------

type TxtResolver = (hostname: string) => Promise<string[][]>;

let txtResolver: TxtResolver = (hostname) => dns.resolveTxt(hostname);

export function setDomainTxtResolverForTests(resolver?: TxtResolver): void {
  txtResolver = resolver ?? ((hostname) => dns.resolveTxt(hostname));
}

// ---------------------------------------------------------------------------
// Tenant scoping helpers (mirrors server/services/notifications.ts)
// ---------------------------------------------------------------------------

function requireDomainViewActor(actor: AuthSession): void {
  if (actor.role === "ADMIN") return;
  if (!actor.clientAccountId) throw new DomainForbiddenError();
}

function requireDomainManageActor(actor: AuthSession): void {
  if (actor.role === "ADMIN") return;
  if (actor.role !== "CLIENT_ADMIN" || !actor.clientAccountId) throw new DomainForbiddenError();
}

function tenantScopeFor(actor: AuthSession): string | null {
  return actor.role === "ADMIN" ? null : actor.clientAccountId!;
}

function assertOwnsClientAccountId(actor: AuthSession, ownerId: string): void {
  if (actor.role === "ADMIN") return;
  if (ownerId !== actor.clientAccountId) throw new DomainForbiddenError();
}

const domainPublicSelect = {
  id: true,
  clientAccountId: true,
  hostname: true,
  status: true,
  verificationToken: true,
  verifiedAt: true,
  lastCheckedAt: true,
  lastCheckError: true,
  createdAt: true,
  updatedAt: true,
  clientAccount: { select: { id: true, name: true } },
  ingressEndpoints: {
    select: { id: true, exposureType: true, status: true, workloadId: true }
  }
} satisfies Prisma.DomainSelect;

export type CreateDomainInput = {
  hostname: string;
  /** ADMIN only: create on behalf of a specific organization. Ignored (forced to actor's own org) for CLIENT_ADMIN. */
  clientAccountId?: string | null;
  actor: AuthSession;
  sourceIp?: string | null;
};

export async function createDomain(input: CreateDomainInput) {
  requireDomainManageActor(input.actor);
  const clientAccountId = input.actor.role === "ADMIN" ? input.clientAccountId : input.actor.clientAccountId!;
  if (!clientAccountId) throw new Error("ORGANIZATION_REQUIRED");

  const account = await prisma.clientAccount.findUnique({
    where: { id: clientAccountId },
    select: { id: true, maxDomains: true }
  });
  if (!account) throw new Error("NOT_FOUND");

  if (account.maxDomains !== null) {
    const existing = await prisma.domain.count({ where: { clientAccountId } });
    if (existing >= account.maxDomains) throw new Error("DOMAIN_QUOTA_EXCEEDED");
  }

  const hostname = input.hostname.toLowerCase();
  const domain = await prisma.domain.create({
    data: {
      clientAccountId,
      hostname,
      verificationToken: generateVerificationToken(),
      createdById: input.actor.userId
    },
    select: domainPublicSelect
  });

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    clientAccountId,
    action: "DOMAIN_CREATED",
    targetType: "DOMAIN",
    targetId: domain.id,
    metadata: { hostname: domain.hostname },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return domain;
}

export async function listDomains(actor: AuthSession) {
  requireDomainViewActor(actor);
  const scope = tenantScopeFor(actor);
  return prisma.domain.findMany({
    where: scope ? { clientAccountId: scope } : {},
    orderBy: { hostname: "asc" },
    select: domainPublicSelect
  });
}

export async function getDomain(id: string, actor: AuthSession) {
  requireDomainViewActor(actor);
  const domain = await prisma.domain.findUnique({ where: { id }, select: domainPublicSelect });
  if (!domain) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(actor, domain.clientAccountId);
  return domain;
}

/**
 * DISABLED = an operator/admin has taken the domain out of service. VERIFIED
 * (re-)enters PENDING_VERIFICATION — enabling a previously-disabled domain
 * re-requires a fresh DNS check rather than trusting a stale verification.
 */
export async function setDomainEnabled(input: { id: string; enabled: boolean; actor: AuthSession; sourceIp?: string | null }) {
  requireDomainManageActor(input.actor);
  const existing = await prisma.domain.findUnique({ where: { id: input.id }, select: { id: true, hostname: true, clientAccountId: true, status: true } });
  if (!existing) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, existing.clientAccountId);

  const domain = await prisma.domain.update({
    where: { id: input.id },
    data: input.enabled
      ? { status: "PENDING_VERIFICATION", verifiedAt: null }
      : { status: "DISABLED" },
    select: domainPublicSelect
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    clientAccountId: domain.clientAccountId,
    action: input.enabled ? "DOMAIN_ENABLED" : "DOMAIN_DISABLED",
    targetType: "DOMAIN",
    targetId: domain.id,
    metadata: { hostname: domain.hostname },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return domain;
}

export async function deleteDomain(input: { id: string; actor: AuthSession; sourceIp?: string | null }): Promise<void> {
  requireDomainManageActor(input.actor);
  const existing = await prisma.domain.findUnique({
    where: { id: input.id },
    select: { id: true, hostname: true, clientAccountId: true, _count: { select: { ingressEndpoints: true } } }
  });
  if (!existing) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, existing.clientAccountId);
  if (existing._count.ingressEndpoints > 0) throw new Error("DOMAIN_HAS_INGRESS_ENDPOINTS");

  await prisma.domain.delete({ where: { id: input.id } });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    clientAccountId: existing.clientAccountId,
    action: "DOMAIN_DELETED",
    targetType: "DOMAIN",
    targetId: input.id,
    metadata: { hostname: existing.hostname },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
}

/**
 * Performs the actual DNS TXT lookup at `_noderaft-challenge.<hostname>` and
 * flips status based on what it observes — VERIFIED if the token is present,
 * INVALID otherwise (no record, wrong value, or the name doesn't resolve at
 * all). A domain taken DISABLED must be re-enabled (which re-arms
 * PENDING_VERIFICATION) before it can be verified again.
 */
export async function verifyDomain(input: { id: string; actor: AuthSession; sourceIp?: string | null }) {
  requireDomainManageActor(input.actor);
  const existing = await prisma.domain.findUnique({ where: { id: input.id } });
  if (!existing) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, existing.clientAccountId);
  if (existing.status === "DISABLED") throw new Error("DOMAIN_DISABLED");

  const now = new Date();
  let verified = false;
  let checkError: string | null = null;
  try {
    const records = await txtResolver(challengeHostname(existing.hostname));
    const expected = verificationTxtValue(existing.verificationToken);
    verified = records.some((chunks) => chunks.join("") === expected);
    if (!verified) checkError = "TXT_RECORD_NOT_FOUND";
  } catch {
    checkError = "DNS_LOOKUP_FAILED";
  }

  const domain = await prisma.domain.update({
    where: { id: input.id },
    data: {
      status: verified ? "VERIFIED" : "INVALID",
      verifiedAt: verified ? now : existing.verifiedAt,
      lastCheckedAt: now,
      lastCheckError: checkError
    },
    select: domainPublicSelect
  });

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    clientAccountId: domain.clientAccountId,
    action: verified ? "DOMAIN_VERIFIED" : "DOMAIN_VERIFICATION_FAILED",
    targetType: "DOMAIN",
    targetId: domain.id,
    metadata: { hostname: domain.hostname, error: checkError },
    result: verified ? "SUCCESS" : "FAILURE",
    sourceIp: input.sourceIp ?? null
  });
  return domain;
}

export type DnsInstructions = {
  status: string;
  verification: { type: "TXT"; host: string; value: string };
  routing: Array<{ type: "A" | "AAAA" | "CNAME"; host: string; value: string; publicAddressId: string | null }>;
};

/**
 * DNS instructions are derived from the CURRENT ingress topology, never
 * hard-coded: if this domain is already bound to an IngressEndpoint, the
 * routing record points at that endpoint's actual PublicAddress/provider.
 * Otherwise it recommends every PublicAddress this organization could use
 * (shared, enabled addresses plus any dedicated to them) so an operator can
 * prepare DNS before creating the endpoint.
 */
export async function dnsInstructionsForDomain(id: string, actor: AuthSession): Promise<DnsInstructions> {
  requireDomainViewActor(actor);
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(actor, domain.clientAccountId);

  const boundEndpoint = await prisma.ingressEndpoint.findUnique({
    where: { domainId: id },
    include: { publicAddress: { include: { provider: true } } }
  });

  const candidates = boundEndpoint
    ? [boundEndpoint.publicAddress]
    : await prisma.publicAddress.findMany({
        where: {
          enabled: true,
          OR: [{ allocation: "SHARED" }, { reservedForOrgId: domain.clientAccountId }]
        },
        include: { provider: true },
        orderBy: { label: "asc" }
      });

  const routing = candidates.map((address) => {
    const gatewayHostname = address.provider?.gatewayHostname ?? null;
    if (gatewayHostname) {
      return { type: "CNAME" as const, host: domain.hostname, value: gatewayHostname, publicAddressId: address.id };
    }
    return {
      type: (address.ipVersion === "V4" ? "A" : "AAAA") as "A" | "AAAA",
      host: domain.hostname,
      value: address.ipAddress,
      publicAddressId: address.id
    };
  });

  return {
    status: domain.status,
    verification: { type: "TXT", host: challengeHostname(domain.hostname), value: verificationTxtValue(domain.verificationToken) },
    routing
  };
}
