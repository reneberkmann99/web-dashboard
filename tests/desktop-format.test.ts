import { describe, expect, it } from "vitest";
import { deriveFreshness, formatAge, formatDuration, freshnessAgeLabel } from "@/lib/freshness";
import { compactMemory, compactUptime, cleanVersion, formatBytesColumn, parseMemoryUsedBytes } from "@/lib/format";
import { parseLogLine } from "@/components/logs/log-viewer";
import { activityRollupSentence, groupActivityEvents, pairIncidentEvents, activityResourceLabel, type TimelineEvent } from "@/components/activity/activity-timeline";
import { groupContainersByWorkload } from "@/components/containers/grouped-containers";
import type { ContainerView } from "@/types/domain";

describe("desktop operator formatting", () => {
  it("derives live, stale, and unavailable freshness from real query inputs", () => {
    expect(deriveFreshness({ ageSeconds: 4, queryError: false, nodesTotal: 2, nodesOnline: 2 })).toEqual({ state: "live", label: "live · 4s ago" });
    expect(deriveFreshness({ ageSeconds: 48, queryError: false, nodesTotal: 2, nodesOnline: 2 }).state).toBe("stale");
    expect(deriveFreshness({ ageSeconds: 2, queryError: false, nodesTotal: 2, nodesOnline: 1 }).state).toBe("stale");
    expect(deriveFreshness({ ageSeconds: 2, queryError: true, nodesTotal: 2, nodesOnline: 2 })).toEqual({ state: "unavailable", label: "agent unavailable" });
  });

  it("formats inventory numbers compactly without host-total noise", () => {
    expect(compactMemory("43.86MiB / 23.48GiB")).toBe("43.9M");
    expect(compactUptime("Up 4 weeks (healthy)")).toBe("4w");
  });

  it("parses only confident timestamp and severity prefixes", () => {
    expect(parseLogLine("2026-08-21T16:38:54Z INFO server ready")).toMatchObject({ time: "16:38:54", message: "INFO server ready", level: "info" });
    expect(parseLogLine("2026-08-21T16:38:54Z WARN queue delayed").level).toBe("warn");
    expect(parseLogLine("2026-08-21T16:38:54Z ERROR request failed").level).toBe("error");
    expect(parseLogLine("payload contains ERROR but is not a severity prefix")).toMatchObject({ timestamp: null, message: "payload contains ERROR but is not a severity prefix", level: null });
  });

  it("humanizes freshness durations instead of exposing raw seconds (round 2 P0 §3)", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(1070)).toBe("18m");
    expect(formatDuration(3 * 3600 + 90)).toBe("3h");
    expect(formatAge(1070)).toBe("18m ago");
    expect(deriveFreshness({ ageSeconds: 1070, queryError: false, nodesTotal: 2, nodesOnline: 1 }).label).toBe("stale · 18m ago");
    expect(deriveFreshness({ ageSeconds: 1070, queryError: false, nodesTotal: 2, nodesOnline: 1 }).label).not.toMatch(/1070s/);
    expect(freshnessAgeLabel(new Date(Date.now() - 125_000).toISOString())).toBe("2m ago");
    expect(freshnessAgeLabel(null)).toBe("never");
  });

  it("strips stray JSON quoting from captured version strings (round 2 P0 §3)", () => {
    expect(cleanVersion('"29.6.2"')).toBe("29.6.2");
    expect(cleanVersion("29.6.2")).toBe("29.6.2");
    expect(cleanVersion(null)).toBeNull();
    expect(cleanVersion("")).toBeNull();
  });

  it("picks one byte unit for a whole column instead of mixing K/M/G per row (round 2 §2/§6)", () => {
    const bytes = [660 * 1024, 750.7 * 1024 * 1024, 2.5 * 1024 * 1024 * 1024];
    const format = formatBytesColumn(bytes);
    expect(format(bytes[0])).toBe("0.0G");
    expect(format(bytes[1])).toBe("0.7G");
    expect(format(bytes[2])).toBe("2.5G");
    expect(format(null)).toBe("—");
    expect(parseMemoryUsedBytes("43.86MiB / 23.48GiB")).toBeCloseTo(43.86 * 1024 * 1024, 0);
    expect(parseMemoryUsedBytes(null)).toBeNull();
  });

  it("groups containers by workload, bucketing unassigned separately (round 2 §6)", () => {
    const base: Partial<ContainerView> = { image: "x", status: "running", uptime: null, ports: "", createdAt: null, cpuPercent: null, memoryUsage: null, restartCount: 0, nodeId: "n1", nodeName: "Main VPS", nodeOnline: true, clientName: "—", allowedActions: [], lastUpdatedAt: "" };
    const containers: ContainerView[] = [
      { ...base, assignmentId: "a1", containerId: "c1", name: "mailcow-1", projectId: "p1", projectName: "Mailcow" } as ContainerView,
      { ...base, assignmentId: "a2", containerId: "c2", name: "mailcow-2", projectId: "p1", projectName: "Mailcow" } as ContainerView,
      { ...base, assignmentId: "a3", containerId: "c3", name: "loose", projectId: null, projectName: null } as ContainerView
    ];
    const groups = groupContainersByWorkload(containers);
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe("Mailcow");
    expect(groups[0].containers).toHaveLength(2);
    expect(groups.find((g) => g.key === "unassigned")?.name).toBe("Unassigned");
  });

  it("pairs an ATTENTION_OPENED/RESOLVED incident into one row with a duration (round 2 §3)", () => {
    const events: TimelineEvent[] = [
      { id: "resolved", action: "ATTENTION_RESOLVED_NODE_OFFLINE", actorEmail: null, createdAt: "2026-08-21T13:28:00Z", targetType: "NODE", targetId: "node1", humanized: "Node recovered" },
      { id: "opened", action: "ATTENTION_OPENED_NODE_OFFLINE", actorEmail: null, createdAt: "2026-08-21T13:27:00Z", targetType: "NODE", targetId: "node1", humanized: "Node went offline" },
      { id: "unrelated", action: "USER_UPDATE", actorEmail: "admin@example.com", createdAt: "2026-08-21T13:20:00Z" }
    ];
    const paired = pairIncidentEvents(events);
    expect(paired).toHaveLength(2);
    expect(paired[0].id).toBe("opened:resolved");
    expect(paired[0].humanized).toBe("Node recovered after 1m");
    expect(paired[1].id).toBe("unrelated");
  });

  it("never falls back to a raw id for the primary Activity resource label (round 2 §8)", () => {
    const resolved: TimelineEvent = { id: "1", action: "NODE_DEACTIVATE", actorEmail: null, createdAt: "now", targetType: "NODE", targetId: "cmt48i7r60002klsxofkizfor", targetLabel: "Main VPS" };
    expect(activityResourceLabel(resolved)).toBe("Main VPS");
    const deleted: TimelineEvent = { id: "2", action: "USER_DELETE", actorEmail: null, createdAt: "now", targetType: "USER", targetId: "cmt48i7r60002klsxofkizfor", targetLabel: "Test User", targetDeleted: true };
    expect(activityResourceLabel(deleted)).toBe("Test User (deleted)");
    const unresolved: TimelineEvent = { id: "3", action: "NODE_UPDATE", actorEmail: null, createdAt: "now", targetType: "NODE", targetId: "cmt48i7r60002klsxofkizfor" };
    expect(activityResourceLabel(unresolved)).toBeNull();
  });

  it("rolls up only consecutive equivalent audit events without losing records", () => {
    const events = [
      { id: "1", action: "USER_DELETE", actorEmail: "admin@example.com", createdAt: "2026-08-21T10:01:00Z", targetLabel: "alice" },
      { id: "2", action: "USER_DELETE", actorEmail: "admin@example.com", createdAt: "2026-08-21T10:00:00Z", targetLabel: "bob" },
      { id: "3", action: "USER_UPDATE", actorEmail: "admin@example.com", createdAt: "2026-08-21T09:59:00Z", targetLabel: "bob" }
    ];
    const groups = groupActivityEvents(events);
    expect(groups).toHaveLength(2);
    expect(groups[0].events.map((event) => event.id)).toEqual(["1", "2"]);
    expect(activityRollupSentence(groups[0].events[0], 2)).toBe("Deleted 2 users");
  });
});
