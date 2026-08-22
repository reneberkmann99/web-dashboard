import { describe, expect, it } from "vitest";
import { deriveFreshness } from "@/lib/freshness";
import { compactMemory, compactUptime } from "@/lib/format";
import { parseLogLine } from "@/components/logs/log-viewer";
import { activityRollupSentence, groupActivityEvents } from "@/components/activity/activity-timeline";

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
