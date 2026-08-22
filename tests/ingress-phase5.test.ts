import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { can, capabilitiesForRole } from "@/server/auth/policy";
import {
  DomainForbiddenError,
  challengeHostname,
  createDomain,
  deleteDomain,
  dnsInstructionsForDomain,
  getDomain,
  listDomains,
  setDomainEnabled,
  setDomainTxtResolverForTests,
  verificationTxtValue,
  verifyDomain
} from "@/server/services/domains";
import {
  IngressForbiddenError,
  checkIngressPortConflict,
  createIngressEndpoint,
  createIngressProvider,
  createPublicAddress,
  deleteIngressEndpoint,
  deletePublicAddress,
  getIngressEndpoint,
  listAvailablePublicAddressesForOrg,
  listIngressEndpoints,
  listPublicAddresses,
  updateIngressEndpoint,
  updatePublicAddress
} from "@/server/services/ingress";

let world: Awaited<ReturnType<typeof seedWorld>>;
let projectB: { id: string; clientAccountId: string | null };

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
  // Fixtures don't include a Project for client B — the port-conflict and
  // isolation tests below need a second organization's own workload.
  projectB = await prisma.project.create({
    data: { name: "B Stack", slug: `b-stack-${world.clientB.id.slice(0, 6)}`, clientAccountId: world.clientB.id, nodeId: world.node2.id, isActive: true }
  });
});

afterEach(() => {
  setDomainTxtResolverForTests();
});

async function verifiedDomain(hostname: string, org: { id: string }, admin = world.adminA) {
  const created = await createDomain({ hostname, actor: sessionFor(admin) });
  const domain = await prisma.domain.findUniqueOrThrow({ where: { id: created.id } });
  setDomainTxtResolverForTests(async (host) => {
    expect(host).toBe(challengeHostname(hostname));
    return [[verificationTxtValue(domain.verificationToken)]];
  });
  const verified = await verifyDomain({ id: created.id, actor: sessionFor(admin) });
  expect(verified.status).toBe("VERIFIED");
  return verified;
}

describe("Phase 5 permissions", () => {
  it("domain.view/ingress.view are granted to every client role; domain.manage/ingress.manage only to CLIENT_ADMIN", () => {
    for (const role of ["CLIENT_ADMIN", "CLIENT_OPERATOR", "CLIENT_VIEWER"] as const) {
      const caps = capabilitiesForRole(role);
      expect(caps).toContain("domain.view");
      expect(caps).toContain("ingress.view");
    }
    expect(capabilitiesForRole("CLIENT_ADMIN")).toContain("domain.manage");
    expect(capabilitiesForRole("CLIENT_ADMIN")).toContain("ingress.manage");
    expect(capabilitiesForRole("CLIENT_OPERATOR")).not.toContain("domain.manage");
    expect(capabilitiesForRole("CLIENT_VIEWER")).not.toContain("ingress.manage");
  });

  it("public_address.manage and ingress_provider.manage are platform-only", () => {
    expect(capabilitiesForRole("ADMIN")).toContain("public_address.manage");
    expect(capabilitiesForRole("ADMIN")).toContain("ingress_provider.manage");
    for (const role of ["CLIENT_ADMIN", "CLIENT_OPERATOR", "CLIENT_VIEWER"] as const) {
      expect(capabilitiesForRole(role)).not.toContain("public_address.manage");
      expect(capabilitiesForRole(role)).not.toContain("ingress_provider.manage");
    }
  });

  it("can() agrees with the capability matrix for a real session", () => {
    expect(can(sessionFor(world.clientAAdmin), "domain.manage")).toBe(true);
    expect(can(sessionFor(world.clientAViewer), "domain.manage")).toBe(false);
    expect(can(sessionFor(world.clientAViewer), "domain.view")).toBe(true);
  });

  it("service layer rejects a non-CLIENT_ADMIN attempting to manage domains, independent of the route-level capability check", async () => {
    await expect(createDomain({ hostname: "viewer-attempt.example.com", actor: sessionFor(world.clientAViewer) }))
      .rejects.toThrow(DomainForbiddenError);
    await expect(createDomain({ hostname: "operator-attempt.example.com", actor: sessionFor(world.clientAOperator) }))
      .rejects.toThrow(DomainForbiddenError);
  });

  it("service layer rejects a non-ADMIN attempting platform-only public address / provider management", async () => {
    await expect(createPublicAddress({ label: "x", ipAddress: "203.0.113.1", ipVersion: "V4", actor: sessionFor(world.clientAAdmin) }))
      .rejects.toThrow(IngressForbiddenError);
    await expect(createIngressProvider({ name: "x", actor: sessionFor(world.clientAAdmin) }))
      .rejects.toThrow(IngressForbiddenError);
    await expect(listPublicAddresses(sessionFor(world.clientAAdmin))).rejects.toThrow(IngressForbiddenError);
  });
});

describe("Phase 5 domain verification lifecycle", () => {
  it("starts PENDING_VERIFICATION, moves to VERIFIED when the TXT record matches", async () => {
    const created = await createDomain({ hostname: "app.pending-example.com", actor: sessionFor(world.clientAAdmin) });
    expect(created.status).toBe("PENDING_VERIFICATION");
    expect(created.verificationToken).toHaveLength(40);

    setDomainTxtResolverForTests(async () => [[verificationTxtValue(created.verificationToken)]]);
    const verified = await verifyDomain({ id: created.id, actor: sessionFor(world.clientAAdmin) });
    expect(verified.status).toBe("VERIFIED");
    expect(verified.verifiedAt).not.toBeNull();
    expect(verified.lastCheckError).toBeNull();
  });

  it("moves to INVALID when the TXT record is missing or wrong", async () => {
    const created = await createDomain({ hostname: "app.wrong-txt-example.com", actor: sessionFor(world.clientAAdmin) });

    setDomainTxtResolverForTests(async () => [["not-the-right-value"]]);
    const wrongValue = await verifyDomain({ id: created.id, actor: sessionFor(world.clientAAdmin) });
    expect(wrongValue.status).toBe("INVALID");
    expect(wrongValue.lastCheckError).toBe("TXT_RECORD_NOT_FOUND");

    setDomainTxtResolverForTests(async () => {
      throw Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const noRecord = await verifyDomain({ id: created.id, actor: sessionFor(world.clientAAdmin) });
    expect(noRecord.status).toBe("INVALID");
    expect(noRecord.lastCheckError).toBe("DNS_LOOKUP_FAILED");
  });

  it("DISABLED is a distinct state that blocks verification until re-enabled", async () => {
    const domain = await verifiedDomain("app.disable-cycle.example.com", world.clientA, world.clientAAdmin);
    const disabled = await setDomainEnabled({ id: domain.id, enabled: false, actor: sessionFor(world.clientAAdmin) });
    expect(disabled.status).toBe("DISABLED");

    await expect(verifyDomain({ id: domain.id, actor: sessionFor(world.clientAAdmin) })).rejects.toThrow("DOMAIN_DISABLED");

    const reEnabled = await setDomainEnabled({ id: domain.id, enabled: true, actor: sessionFor(world.clientAAdmin) });
    // Re-enabling requires a fresh check rather than trusting the stale VERIFIED state.
    expect(reEnabled.status).toBe("PENDING_VERIFICATION");
  });

  it("cannot delete a domain that still has an ingress endpoint bound to it", async () => {
    const domain = await verifiedDomain("app.bound-delete.example.com", world.clientA, world.clientAAdmin);
    const address = await createPublicAddress({ label: "Shared v4", ipAddress: "203.0.113.20", ipVersion: "V4", actor: sessionFor(world.adminA) });
    await createIngressEndpoint({
      workloadId: world.projectA.id,
      containerId: world.web.id,
      targetPort: 8080,
      exposureType: "HTTPS",
      domainId: domain.id,
      publicAddressId: address.id,
      actor: sessionFor(world.clientAAdmin)
    });

    await expect(deleteDomain({ id: domain.id, actor: sessionFor(world.clientAAdmin) })).rejects.toThrow("DOMAIN_HAS_INGRESS_ENDPOINTS");
  });
});

describe("Phase 5 organization isolation", () => {
  it("a CLIENT_ADMIN cannot see, verify, or delete another organization's domain", async () => {
    const domainA = await createDomain({ hostname: "isolated-a.example.com", actor: sessionFor(world.clientAAdmin) });

    const listedByB = await listDomains(sessionFor(world.clientBOperator));
    expect(listedByB.find((d) => d.id === domainA.id)).toBeUndefined();

    await expect(getDomain(domainA.id, sessionFor(world.clientBOperator))).rejects.toThrow(DomainForbiddenError);

    // Sanity: ADMIN may act on any org's domain (a real DNS lookup would be
    // slow/flaky here, so keep the resolver mocked like every other test).
    setDomainTxtResolverForTests(async () => [["irrelevant"]]);
    await expect(verifyDomain({ id: domainA.id, actor: sessionFor(world.adminA), sourceIp: null })).resolves.toBeTruthy();

    // Need a CLIENT_ADMIN on client B to test the manage path (clientBOperator is not CLIENT_ADMIN).
    const clientBAdmin = await prisma.user.create({
      data: {
        email: `b-admin-${domainA.id}@client-b.local`,
        displayName: "B Admin",
        passwordHash: world.password,
        role: "CLIENT_ADMIN",
        clientAccountId: world.clientB.id,
        isActive: true
      }
    });
    await expect(deleteDomain({ id: domainA.id, actor: sessionFor(clientBAdmin) })).rejects.toThrow(DomainForbiddenError);
  });

  it("a non-ADMIN cannot force-create a domain under a different organization's id", async () => {
    const domain = await createDomain({ hostname: "forced-org.example.com", clientAccountId: world.clientB.id, actor: sessionFor(world.clientAAdmin) });
    expect(domain.clientAccountId).toBe(world.clientA.id);
  });

  it("listIngressEndpoints / getIngressEndpoint scope to the caller's own organization", async () => {
    const address = await createPublicAddress({ label: "Shared v4 isolation", ipAddress: "203.0.113.30", ipVersion: "V4", actor: sessionFor(world.adminA) });
    const endpointA = await createIngressEndpoint({
      workloadId: world.projectA.id,
      targetPort: 9000,
      exposureType: "TCP",
      publicAddressId: address.id,
      publicPort: 19000,
      actor: sessionFor(world.clientAAdmin)
    });
    const endpointB = await createIngressEndpoint({
      workloadId: projectB.id,
      targetPort: 9001,
      exposureType: "TCP",
      publicAddressId: address.id,
      publicPort: 19001,
      actor: sessionFor(world.adminA),
      clientAccountId: world.clientB.id
    });

    const listedByA = await listIngressEndpoints(sessionFor(world.clientAOperator));
    expect(listedByA.map((e) => e.id)).toContain(endpointA.id);
    expect(listedByA.map((e) => e.id)).not.toContain(endpointB.id);

    await expect(getIngressEndpoint(endpointB.id, sessionFor(world.clientAOperator))).rejects.toThrow(IngressForbiddenError);
    await expect(updateIngressEndpoint({ id: endpointB.id, statusDetail: "hijack attempt", actor: sessionFor(world.clientAAdmin) }))
      .rejects.toThrow(IngressForbiddenError);
    await expect(deleteIngressEndpoint({ id: endpointB.id, actor: sessionFor(world.clientAAdmin) })).rejects.toThrow(IngressForbiddenError);
  });
});

describe("Phase 5 public addresses: multiple WAN IPs, shared vs dedicated", () => {
  it("supports multiple independent public addresses (v4 and v6) rather than assuming one global WAN IP", async () => {
    const v4 = await createPublicAddress({ label: "Gateway v4", ipAddress: "203.0.113.40", ipVersion: "V4", actor: sessionFor(world.adminA) });
    const v6 = await createPublicAddress({ label: "Gateway v6", ipAddress: "2001:db8::40", ipVersion: "V6", actor: sessionFor(world.adminA) });
    expect(v4.id).not.toBe(v6.id);
    const all = await listPublicAddresses(sessionFor(world.adminA));
    expect(all.map((a) => a.id)).toEqual(expect.arrayContaining([v4.id, v6.id]));
  });

  it("rejects an IP address that doesn't match the declared version", async () => {
    await expect(createPublicAddress({ label: "bad", ipAddress: "203.0.113.50", ipVersion: "V6", actor: sessionFor(world.adminA) }))
      .rejects.toThrow("INVALID_IP_ADDRESS");
  });

  it("a SHARED address may not be reserved to an organization", async () => {
    await expect(createPublicAddress({
      label: "bad-shared", ipAddress: "203.0.113.51", ipVersion: "V4", allocation: "SHARED",
      reservedForOrgId: world.clientA.id, actor: sessionFor(world.adminA)
    })).rejects.toThrow("SHARED_ADDRESS_CANNOT_BE_RESERVED");
  });

  it("a DEDICATED address reserved to organization A cannot be bound by organization B's endpoint", async () => {
    const dedicated = await createPublicAddress({
      label: "Dedicated for A", ipAddress: "203.0.113.60", ipVersion: "V4", allocation: "DEDICATED",
      reservedForOrgId: world.clientA.id, actor: sessionFor(world.adminA)
    });

    // Client A may use it.
    const okEndpoint = await createIngressEndpoint({
      workloadId: world.projectA.id,
      targetPort: 5000,
      exposureType: "TCP",
      publicAddressId: dedicated.id,
      publicPort: 15000,
      actor: sessionFor(world.clientAAdmin)
    });
    expect(okEndpoint.publicAddress.id).toBe(dedicated.id);

    // Client B may not, even on a different port.
    await expect(createIngressEndpoint({
      workloadId: projectB.id,
      targetPort: 5001,
      exposureType: "TCP",
      publicAddressId: dedicated.id,
      publicPort: 15001,
      actor: sessionFor(world.adminA),
      clientAccountId: world.clientB.id
    })).rejects.toThrow("PUBLIC_ADDRESS_RESERVED");
  });

  it("a shared address is available to every organization's picker; a dedicated one only to its reserved organization", async () => {
    const shared = await createPublicAddress({ label: "Shared picker", ipAddress: "203.0.113.70", ipVersion: "V4", actor: sessionFor(world.adminA) });
    const dedicated = await createPublicAddress({
      label: "Dedicated picker", ipAddress: "203.0.113.71", ipVersion: "V4", allocation: "DEDICATED",
      reservedForOrgId: world.clientA.id, actor: sessionFor(world.adminA)
    });

    const forA = await listAvailablePublicAddressesForOrg(world.clientA.id);
    const forB = await listAvailablePublicAddressesForOrg(world.clientB.id);
    expect(forA.map((a) => a.id)).toEqual(expect.arrayContaining([shared.id, dedicated.id]));
    expect(forB.map((a) => a.id)).toContain(shared.id);
    expect(forB.map((a) => a.id)).not.toContain(dedicated.id);
  });

  it("enforces the organization's maxDedicatedIps quota", async () => {
    // Other tests in this file also reserve dedicated addresses to client A —
    // set the quota relative to what's already there rather than assuming 0.
    const before = await prisma.publicAddress.count({ where: { reservedForOrgId: world.clientA.id, allocation: "DEDICATED" } });
    await prisma.clientAccount.update({ where: { id: world.clientA.id }, data: { maxDedicatedIps: before + 1 } });
    await createPublicAddress({
      label: "Quota 1", ipAddress: "203.0.113.80", ipVersion: "V4", allocation: "DEDICATED",
      reservedForOrgId: world.clientA.id, actor: sessionFor(world.adminA)
    });
    await expect(createPublicAddress({
      label: "Quota 2", ipAddress: "203.0.113.81", ipVersion: "V4", allocation: "DEDICATED",
      reservedForOrgId: world.clientA.id, actor: sessionFor(world.adminA)
    })).rejects.toThrow("DEDICATED_IP_QUOTA_EXCEEDED");
    await prisma.clientAccount.update({ where: { id: world.clientA.id }, data: { maxDedicatedIps: null } });
  });

  it("cannot delete a public address still referenced by an ingress endpoint", async () => {
    const address = await createPublicAddress({ label: "In use", ipAddress: "203.0.113.90", ipVersion: "V4", actor: sessionFor(world.adminA) });
    await createIngressEndpoint({
      workloadId: world.projectA.id,
      targetPort: 6000,
      exposureType: "UDP",
      publicAddressId: address.id,
      publicPort: 16000,
      actor: sessionFor(world.clientAAdmin)
    });
    await expect(deletePublicAddress({ id: address.id, actor: sessionFor(world.adminA) })).rejects.toThrow("PUBLIC_ADDRESS_IN_USE");
  });

  it("supports updating a public address (label, enabled, reservation)", async () => {
    const address = await createPublicAddress({ label: "Updatable", ipAddress: "203.0.113.95", ipVersion: "V4", actor: sessionFor(world.adminA) });
    const updated = await updatePublicAddress({ id: address.id, label: "Renamed", enabled: false, actor: sessionFor(world.adminA) });
    expect(updated.label).toBe("Renamed");
    expect(updated.enabled).toBe(false);
  });
});

describe("Phase 5 TCP/UDP port conflict detection", () => {
  it("detects a conflict for the same (address, port, protocol) tuple before create, across organizations", async () => {
    const address = await createPublicAddress({ label: "Conflict test", ipAddress: "203.0.113.100", ipVersion: "V4", actor: sessionFor(world.adminA) });

    await createIngressEndpoint({
      workloadId: world.projectA.id,
      targetPort: 5432,
      exposureType: "TCP",
      publicAddressId: address.id,
      publicPort: 25432,
      actor: sessionFor(world.clientAAdmin)
    });

    expect(await checkIngressPortConflict({ publicAddressId: address.id, publicPort: 25432, exposureType: "TCP" })).toBe(true);

    await expect(createIngressEndpoint({
      workloadId: projectB.id,
      targetPort: 5432,
      exposureType: "TCP",
      publicAddressId: address.id,
      publicPort: 25432,
      actor: sessionFor(world.adminA),
      clientAccountId: world.clientB.id
    })).rejects.toThrow("PORT_CONFLICT");
  });

  it("does not conflict across different protocols or different ports on the same address", async () => {
    const address = await createPublicAddress({ label: "No conflict test", ipAddress: "203.0.113.101", ipVersion: "V4", actor: sessionFor(world.adminA) });
    await createIngressEndpoint({
      workloadId: world.projectA.id,
      targetPort: 53,
      exposureType: "UDP",
      publicAddressId: address.id,
      publicPort: 25053,
      actor: sessionFor(world.clientAAdmin)
    });

    // Same port, different protocol: fine.
    const tcpSamePort = await createIngressEndpoint({
      workloadId: projectB.id,
      targetPort: 53,
      exposureType: "TCP",
      publicAddressId: address.id,
      publicPort: 25053,
      actor: sessionFor(world.adminA),
      clientAccountId: world.clientB.id
    });
    expect(tcpSamePort.exposureType).toBe("TCP");

    // Same protocol, different port: fine.
    const udpDifferentPort = await createIngressEndpoint({
      workloadId: projectB.id,
      targetPort: 53,
      exposureType: "UDP",
      publicAddressId: address.id,
      publicPort: 25054,
      actor: sessionFor(world.adminA),
      clientAccountId: world.clientB.id
    });
    expect(udpDifferentPort.publicPort).toBe(25054);
  });

  it("enforces the organization's maxTcpUdpEndpoints quota", async () => {
    const address = await createPublicAddress({ label: "Quota tcp", ipAddress: "203.0.113.102", ipVersion: "V4", actor: sessionFor(world.adminA) });
    const before = await prisma.ingressEndpoint.count({ where: { clientAccountId: world.clientA.id, exposureType: { in: ["TCP", "UDP"] } } });
    await prisma.clientAccount.update({ where: { id: world.clientA.id }, data: { maxTcpUdpEndpoints: before + 1 } });
    await createIngressEndpoint({
      workloadId: world.projectA.id, targetPort: 7000, exposureType: "TCP", publicAddressId: address.id, publicPort: 27000,
      actor: sessionFor(world.clientAAdmin)
    });
    await expect(createIngressEndpoint({
      workloadId: world.projectA.id, targetPort: 7001, exposureType: "TCP", publicAddressId: address.id, publicPort: 27001,
      actor: sessionFor(world.clientAAdmin)
    })).rejects.toThrow("TCP_UDP_ENDPOINT_QUOTA_EXCEEDED");
    await prisma.clientAccount.update({ where: { id: world.clientA.id }, data: { maxTcpUdpEndpoints: null } });
  });
});

describe("Phase 5 HTTP(S) endpoints require a verified, unbound domain", () => {
  it("rejects an HTTPS endpoint whose domain is not yet verified", async () => {
    const domain = await createDomain({ hostname: "unverified.example.com", actor: sessionFor(world.clientAAdmin) });
    const address = await createPublicAddress({ label: "For unverified", ipAddress: "203.0.113.110", ipVersion: "V4", actor: sessionFor(world.adminA) });
    await expect(createIngressEndpoint({
      workloadId: world.projectA.id, targetPort: 8080, exposureType: "HTTPS", domainId: domain.id, publicAddressId: address.id,
      actor: sessionFor(world.clientAAdmin)
    })).rejects.toThrow("DOMAIN_NOT_VERIFIED");
  });

  it("rejects binding a domain to a second endpoint once it's already bound", async () => {
    const domain = await verifiedDomain("already-bound.example.com", world.clientA, world.clientAAdmin);
    const address = await createPublicAddress({ label: "Bound test", ipAddress: "203.0.113.111", ipVersion: "V4", actor: sessionFor(world.adminA) });
    await createIngressEndpoint({
      workloadId: world.projectA.id, targetPort: 8080, exposureType: "HTTPS", domainId: domain.id, publicAddressId: address.id,
      actor: sessionFor(world.clientAAdmin)
    });
    const address2 = await createPublicAddress({ label: "Bound test 2", ipAddress: "203.0.113.112", ipVersion: "V4", actor: sessionFor(world.adminA) });
    await expect(createIngressEndpoint({
      workloadId: world.projectA.id, targetPort: 8081, exposureType: "HTTPS", domainId: domain.id, publicAddressId: address2.id,
      actor: sessionFor(world.clientAAdmin)
    })).rejects.toThrow("DOMAIN_ALREADY_BOUND");
  });

  it("rejects a TCP/UDP endpoint that sets a domain, and an HTTP(S) endpoint that sets a public port", async () => {
    const domain = await verifiedDomain("wrong-shape.example.com", world.clientA, world.clientAAdmin);
    const address = await createPublicAddress({ label: "Shape test", ipAddress: "203.0.113.113", ipVersion: "V4", actor: sessionFor(world.adminA) });
    await expect(createIngressEndpoint({
      workloadId: world.projectA.id, targetPort: 53, exposureType: "UDP", domainId: domain.id, publicAddressId: address.id,
      actor: sessionFor(world.clientAAdmin)
    })).rejects.toThrow("TCP_UDP_ENDPOINT_CANNOT_HAVE_DOMAIN");

    await expect(createIngressEndpoint({
      workloadId: world.projectA.id, targetPort: 8080, exposureType: "HTTP", domainId: domain.id, publicAddressId: address.id, publicPort: 8080,
      actor: sessionFor(world.clientAAdmin)
    })).rejects.toThrow("HTTP_ENDPOINT_CANNOT_SET_PUBLIC_PORT");
  });

  it("DNS instructions recommend a CNAME to the provider's gateway hostname when one is set, otherwise an A/AAAA record to the public address", async () => {
    const cnameProvider = await createIngressProvider({ name: "Gatewayed", gatewayHostname: "gw.noderaft-test.net", actor: sessionFor(world.adminA) });
    const addressWithProvider = await createPublicAddress({
      label: "Behind gateway", ipAddress: "203.0.113.120", ipVersion: "V4", providerId: cnameProvider.id, actor: sessionFor(world.adminA)
    });
    const domain = await createDomain({ hostname: "gatewayed.example.com", actor: sessionFor(world.clientAAdmin) });

    const beforeBinding = await dnsInstructionsForDomain(domain.id, sessionFor(world.clientAAdmin));
    expect(beforeBinding.verification.type).toBe("TXT");
    expect(beforeBinding.verification.host).toBe(challengeHostname("gatewayed.example.com"));

    setDomainTxtResolverForTests(async () => [[verificationTxtValue((await getDomain(domain.id, sessionFor(world.clientAAdmin))).verificationToken)]]);
    await verifyDomain({ id: domain.id, actor: sessionFor(world.clientAAdmin) });
    await createIngressEndpoint({
      workloadId: world.projectA.id, targetPort: 8080, exposureType: "HTTPS", domainId: domain.id, publicAddressId: addressWithProvider.id,
      actor: sessionFor(world.clientAAdmin)
    });

    const afterBinding = await dnsInstructionsForDomain(domain.id, sessionFor(world.clientAAdmin));
    expect(afterBinding.routing).toHaveLength(1);
    expect(afterBinding.routing[0]).toMatchObject({ type: "CNAME", value: "gw.noderaft-test.net" });

    const plainAddress = await createPublicAddress({ label: "No provider", ipAddress: "203.0.113.121", ipVersion: "V4", actor: sessionFor(world.adminA) });
    const domain2 = await createDomain({ hostname: "plain-a-record.example.com", actor: sessionFor(world.clientAAdmin) });
    const instructions2 = await dnsInstructionsForDomain(domain2.id, sessionFor(world.clientAAdmin));
    const plainCandidate = instructions2.routing.find((r) => r.publicAddressId === plainAddress.id);
    expect(plainCandidate).toMatchObject({ type: "A", value: "203.0.113.121" });
  });
});

describe("Phase 5 endpoint identity is independent of the workload's current node", () => {
  it("an ingress endpoint's id, hostname/port, and public address survive the workload relocating to a different node", async () => {
    const domain = await verifiedDomain("relocation.example.com", world.clientA, world.clientAAdmin);
    const address = await createPublicAddress({ label: "Relocation test", ipAddress: "203.0.113.130", ipVersion: "V4", actor: sessionFor(world.adminA) });
    const endpoint = await createIngressEndpoint({
      workloadId: world.projectA.id,
      containerId: world.web.id,
      targetPort: 8080,
      exposureType: "HTTPS",
      domainId: domain.id,
      publicAddressId: address.id,
      actor: sessionFor(world.clientAAdmin)
    });

    expect(endpoint).not.toHaveProperty("nodeId");
    expect(endpoint.workload.nodeId).toBe(world.node1.id);

    // Simulate relocation: the workload now runs on a different node. Nothing
    // about the endpoint's own identity (id, domain/hostname, public
    // address/port) is derived from the node, so none of it should change.
    await prisma.project.update({ where: { id: world.projectA.id }, data: { nodeId: world.node2.id } });

    const afterRelocation = await getIngressEndpoint(endpoint.id, sessionFor(world.clientAAdmin));
    expect(afterRelocation.id).toBe(endpoint.id);
    expect(afterRelocation.domain?.hostname).toBe("relocation.example.com");
    expect(afterRelocation.publicAddress.id).toBe(address.id);
    expect(afterRelocation.publicAddress.ipAddress).toBe("203.0.113.130");
    expect(afterRelocation.status).toBe(endpoint.status);
    expect(afterRelocation.workload.nodeId).toBe(world.node2.id); // the backend moved
    expect(afterRelocation).not.toHaveProperty("nodeId"); // the endpoint's own identity never had one

    await prisma.project.update({ where: { id: world.projectA.id }, data: { nodeId: world.node1.id } });
  });
});

describe("Phase 5 quotas", () => {
  it("enforces maxDomains and maxIngressEndpoints", async () => {
    await prisma.clientAccount.update({ where: { id: world.clientB.id }, data: { maxDomains: 1 } });
    const clientBAdmin = await prisma.user.create({
      data: {
        email: `b-admin-quota-${Date.now()}@client-b.local`,
        displayName: "B Admin Quota",
        passwordHash: world.password,
        role: "CLIENT_ADMIN",
        clientAccountId: world.clientB.id,
        isActive: true
      }
    });
    await createDomain({ hostname: `quota-1-${Date.now()}.example.com`, actor: sessionFor(clientBAdmin) });
    await expect(createDomain({ hostname: `quota-2-${Date.now()}.example.com`, actor: sessionFor(clientBAdmin) }))
      .rejects.toThrow("DOMAIN_QUOTA_EXCEEDED");
    await prisma.clientAccount.update({ where: { id: world.clientB.id }, data: { maxDomains: null } });

    await prisma.clientAccount.update({ where: { id: world.clientA.id }, data: { maxIngressEndpoints: 0 } });
    const address = await createPublicAddress({ label: "Quota endpoints", ipAddress: "203.0.113.140", ipVersion: "V4", actor: sessionFor(world.adminA) });
    await expect(createIngressEndpoint({
      workloadId: world.projectA.id, targetPort: 9090, exposureType: "TCP", publicAddressId: address.id, publicPort: 29090,
      actor: sessionFor(world.clientAAdmin)
    })).rejects.toThrow("INGRESS_ENDPOINT_QUOTA_EXCEEDED");
    await prisma.clientAccount.update({ where: { id: world.clientA.id }, data: { maxIngressEndpoints: null } });
  });
});
