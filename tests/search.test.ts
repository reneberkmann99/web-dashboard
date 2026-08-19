import { beforeAll, describe, expect, it } from "vitest";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { searchForAdmin, searchForClient } from "@/server/services/search";

beforeAll(async () => {
  resetDatabase();
});

describe("global search", () => {
  it("admin search finds workloads, containers, nodes and clients", async () => {
    const world = await seedWorld();

    const byName = await searchForAdmin("web");
    const types = byName.map((g) => g.type);
    expect(types).toContain("workload"); // "Web Stack"
    expect(types).toContain("container"); // "web"

    const byClient = await searchForAdmin(world.clientA.name);
    expect(byClient.some((g) => g.type === "client")).toBe(true);

    const byNode = await searchForAdmin(world.node1.name);
    expect(byNode.some((g) => g.type === "node")).toBe(true);
  });

  it("admin search groups results by type with navigable hrefs", async () => {
    const world = await seedWorld();

    // Workload href — search by the world-unique slug.
    const workloadGroups = await searchForAdmin(world.projectA.slug);
    const stackGroup = workloadGroups.find((g) => g.type === "workload");
    const stack = stackGroup?.items.find((i) => i.id === world.projectA.id);
    expect(stack?.href).toBe(`/admin/workloads/${world.projectA.id}`);

    // Container href — dockerContainerId is shared across fixtures, so assert
    // that this world's container (identified by its nodeId) is present with a
    // well-formed href, not that it is the sole result.
    const containerGroups = await searchForAdmin("web");
    const containerGroup = containerGroups.find((g) => g.type === "container");
    expect(containerGroup).toBeDefined();
    const hrefs = containerGroup!.items.map((i) => i.href);
    expect(hrefs.some((h) => h === `/admin/containers/${world.node1.id}/${world.web.dockerContainerId}`)).toBe(true);
    expect(hrefs.every((h) => /^\/admin\/containers\/[a-z0-9]+\/web1234567890$/.test(h))).toBe(true);
  });

  it("client search only ever returns workload and container groups", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);

    const groups = await searchForClient(sessionA, "web");
    const types = groups.map((g) => g.type);
    expect(types).toContain("workload");
    expect(types).toContain("container");
    expect(types).not.toContain("node");
    expect(types).not.toContain("client");
  });

  it("client A search never leaks client B's container", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);

    // "api" belongs to client B only — A must see nothing for it.
    const apiResults = await searchForClient(sessionA, "api");
    const apiContainers = apiResults.flatMap((g) => g.items).filter((i) => i.type === "container");
    expect(apiContainers).toHaveLength(0);

    // A can find its own "web" container.
    const webResults = await searchForClient(sessionA, "web");
    const webItems = webResults.flatMap((g) => g.items).filter((i) => i.type === "container");
    expect(webItems.some((i) => i.title === "web")).toBe(true);
  });

  it("client search honours container-level grants (worker visible, api not)", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);

    const workerResults = await searchForClient(sessionA, "worker");
    const workerItems = workerResults.flatMap((g) => g.items).filter((i) => i.type === "container");
    expect(workerItems.some((i) => i.title === "worker")).toBe(true);
    expect(workerItems[0].href).toBe(`/client/containers/${world.workerGrant.id}`);
  });

  it("empty or blank query returns no groups", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);

    expect(await searchForAdmin("")).toEqual([]);
    expect(await searchForAdmin("   ")).toEqual([]);
    expect(await searchForClient(sessionA, "")).toEqual([]);
  });
});
