import { Prisma, type AttentionResourceType, type LifecycleScopeType } from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import type { AuthSession } from "@/server/auth/session";

export type ConditionResourceContext = {
  nodeId: string | null;
  workloadId: string | null;
};

export type LifecyclePolicyContext = ConditionResourceContext & {
  activeSilences: Array<{
    id: string;
    scope: LifecycleScopeType;
    endsAt: Date;
    reason: string | null;
    createdBy: { displayName: string; email: string } | null;
  }>;
  activeMaintenance: Array<{
    id: string;
    scope: LifecycleScopeType;
    startsAt: Date;
    endsAt: Date;
    reason: string | null;
    notificationBehavior: "SUPPRESS" | "KEEP";
    createdBy: { displayName: string; email: string } | null;
  }>;
  notificationsSuppressed: boolean;
};

type StateIdentity = {
  id: string;
  resourceType: AttentionResourceType;
  resourceId: string;
  metadata: unknown;
};

function nodeIdFromState(state: StateIdentity): string | null {
  if (state.resourceType === "NODE") return state.resourceId;
  if (state.resourceType === "CONTAINER") return state.resourceId.split(":")[0] ?? null;
  const metadata = state.metadata && typeof state.metadata === "object"
    ? state.metadata as Record<string, unknown>
    : null;
  return typeof metadata?.nodeId === "string" ? metadata.nodeId : null;
}

/** Resolve node/workload ancestry without trusting browser-provided scope data. */
export async function resolveConditionResourceContext(state: StateIdentity): Promise<ConditionResourceContext> {
  const nodeId = nodeIdFromState(state);
  if (state.resourceType === "WORKLOAD") return { nodeId, workloadId: state.resourceId };

  if (state.resourceType === "CONTAINER" && nodeId) {
    const dockerContainerId = state.resourceId.slice(nodeId.length + 1);
    const container = await prisma.container.findUnique({
      where: { nodeId_dockerContainerId: { nodeId, dockerContainerId } },
      select: { projectId: true }
    });
    return { nodeId, workloadId: container?.projectId ?? null };
  }

  if (state.resourceType === "DEPLOYMENT") {
    const deployment = await prisma.deployment.findUnique({
      where: { id: state.resourceId },
      select: { projectId: true, project: { select: { nodeId: true } } }
    });
    return {
      nodeId: deployment?.project.nodeId ?? nodeId,
      workloadId: deployment?.projectId ?? null
    };
  }

  return { nodeId, workloadId: null };
}

export async function getLifecyclePolicyContext(
  state: StateIdentity,
  now = new Date()
): Promise<LifecyclePolicyContext> {
  return (await getLifecyclePolicyContexts([state], now)).get(state.id)!;
}

/** Batch lifecycle annotation for fleet/Attention Center reads (no N+1). */
export async function getLifecyclePolicyContexts(
  states: StateIdentity[],
  now = new Date()
): Promise<Map<string, LifecyclePolicyContext>> {
  if (states.length === 0) return new Map();
  const resourceByState = new Map<string, ConditionResourceContext>();
  for (const state of states) {
    resourceByState.set(state.id, {
      nodeId: nodeIdFromState(state),
      workloadId: state.resourceType === "WORKLOAD" ? state.resourceId : null
    });
  }

  const containerStates = states.filter((state) => state.resourceType === "CONTAINER");
  const deploymentStates = states.filter((state) => state.resourceType === "DEPLOYMENT");
  const [containers, deployments] = await Promise.all([
    containerStates.length === 0
      ? Promise.resolve([])
      : prisma.container.findMany({
          where: {
            OR: containerStates.map((state) => {
              const nodeId = nodeIdFromState(state)!;
              return { nodeId, dockerContainerId: state.resourceId.slice(nodeId.length + 1) };
            })
          },
          select: { nodeId: true, dockerContainerId: true, projectId: true }
        }),
    deploymentStates.length === 0
      ? Promise.resolve([])
      : prisma.deployment.findMany({
          where: { id: { in: deploymentStates.map((state) => state.resourceId) } },
          select: { id: true, projectId: true, project: { select: { nodeId: true } } }
        })
  ]);
  const containerProject = new Map(containers.map((row) => [`${row.nodeId}:${row.dockerContainerId}`, row.projectId]));
  const deploymentProject = new Map(deployments.map((row) => [row.id, { workloadId: row.projectId, nodeId: row.project.nodeId }]));
  for (const state of states) {
    const resource = resourceByState.get(state.id)!;
    if (state.resourceType === "CONTAINER") resource.workloadId = containerProject.get(state.resourceId) ?? null;
    if (state.resourceType === "DEPLOYMENT") {
      const deployment = deploymentProject.get(state.resourceId);
      if (deployment) resourceByState.set(state.id, deployment);
    }
  }

  const nodeIds = Array.from(new Set(Array.from(resourceByState.values()).map((item) => item.nodeId).filter((id): id is string => Boolean(id))));
  const workloadIds = Array.from(new Set(Array.from(resourceByState.values()).map((item) => item.workloadId).filter((id): id is string => Boolean(id))));
  const stateIds = states.map((state) => state.id);
  const [silences, maintenance] = await Promise.all([
    prisma.attentionSilence.findMany({
      where: {
        cancelledAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
        OR: [
          { attentionStateId: { in: stateIds } },
          ...(nodeIds.length > 0 ? [{ nodeId: { in: nodeIds } }] : []),
          ...(workloadIds.length > 0 ? [{ workloadId: { in: workloadIds } }] : [])
        ]
      },
      orderBy: { endsAt: "asc" },
      include: { createdBy: { select: { displayName: true, email: true } } }
    }),
    prisma.maintenanceWindow.findMany({
      where: {
        cancelledAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
        OR: [
          ...(nodeIds.length > 0 ? [{ nodeId: { in: nodeIds } }] : []),
          ...(workloadIds.length > 0 ? [{ workloadId: { in: workloadIds } }] : [])
        ]
      },
      orderBy: { endsAt: "asc" },
      include: { createdBy: { select: { displayName: true, email: true } } }
    })
  ]);

  const output = new Map<string, LifecyclePolicyContext>();
  for (const state of states) {
    const resource = resourceByState.get(state.id)!;
    const stateSilences = silences.filter((row) =>
      row.attentionStateId === state.id ||
      (resource.nodeId && row.nodeId === resource.nodeId) ||
      (resource.workloadId && row.workloadId === resource.workloadId)
    );
    const stateMaintenance = maintenance.filter((row) =>
      (resource.nodeId && row.nodeId === resource.nodeId) ||
      (resource.workloadId && row.workloadId === resource.workloadId)
    );
    output.set(state.id, {
      ...resource,
      activeSilences: stateSilences.map((row) => ({
        id: row.id,
        scope: row.scope,
        endsAt: row.endsAt,
        reason: row.reason,
        createdBy: row.createdBy
      })),
      activeMaintenance: stateMaintenance.map((row) => ({
        id: row.id,
        scope: row.scope,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        reason: row.reason,
        notificationBehavior: row.notificationBehavior,
        createdBy: row.createdBy
      })),
      notificationsSuppressed:
        stateSilences.length > 0 || stateMaintenance.some((row) => row.notificationBehavior === "SUPPRESS")
    });
  }
  return output;
}

const acknowledgementInclude = {
  acknowledgedBy: { select: { displayName: true, email: true } },
  clearedBy: { select: { displayName: true, email: true } }
} satisfies Prisma.AttentionAcknowledgementInclude;

export async function getActiveAcknowledgement(attentionStateId: string) {
  return prisma.attentionAcknowledgement.findFirst({
    where: { attentionStateId, clearedAt: null },
    orderBy: { acknowledgedAt: "desc" },
    include: acknowledgementInclude
  });
}

export async function acknowledgeAttention(input: {
  attentionStateId: string;
  actor: AuthSession;
  note?: string | null;
  sourceIp?: string | null;
}) {
  const state = await prisma.attentionState.findUnique({
    where: { id: input.attentionStateId },
    select: { id: true, resolvedAt: true, conditionType: true, resourceType: true, resourceId: true }
  });
  if (!state || state.resolvedAt) throw new Error("ATTENTION_NOT_ACTIVE");

  const note = input.note?.trim() || null;
  const alreadyActive = await getActiveAcknowledgement(state.id);
  if (alreadyActive) return alreadyActive;
  let created = false;
  try {
    await prisma.attentionAcknowledgement.create({
      data: {
        attentionStateId: state.id,
        acknowledgedById: input.actor.userId,
        note
      }
    });
    created = true;
  } catch (error) {
    // Two administrators can acknowledge concurrently. The partial unique
    // index is authoritative; the loser receives the already-current state.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
  }

  const current = await getActiveAcknowledgement(state.id);
  if (created) {
    await logAuditEvent({
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      actorRole: input.actor.role,
      action: `ATTENTION_ACKNOWLEDGED_${state.conditionType}`,
      targetType: state.resourceType,
      targetId: state.resourceId,
      metadata: { attentionStateId: state.id, hasNote: Boolean(note) },
      result: "SUCCESS",
      sourceIp: input.sourceIp ?? null
    });
  }
  return current;
}

export async function unacknowledgeAttention(input: {
  attentionStateId: string;
  actor: AuthSession;
  sourceIp?: string | null;
}) {
  const state = await prisma.attentionState.findUnique({
    where: { id: input.attentionStateId },
    select: { id: true, conditionType: true, resourceType: true, resourceId: true }
  });
  if (!state) throw new Error("NOT_FOUND");
  const now = new Date();
  const result = await prisma.attentionAcknowledgement.updateMany({
    where: { attentionStateId: state.id, clearedAt: null },
    data: { clearedAt: now, clearedById: input.actor.userId, clearedReason: "manual" }
  });
  if (result.count > 0) {
    await logAuditEvent({
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      actorRole: input.actor.role,
      action: `ATTENTION_UNACKNOWLEDGED_${state.conditionType}`,
      targetType: state.resourceType,
      targetId: state.resourceId,
      metadata: { attentionStateId: state.id },
      result: "SUCCESS",
      sourceIp: input.sourceIp ?? null
    });
  }
  return getActiveAcknowledgement(state.id);
}

async function assertScopeTarget(input: {
  scope: LifecycleScopeType;
  attentionStateId?: string | null;
  nodeId?: string | null;
  workloadId?: string | null;
}): Promise<void> {
  if (input.scope === "CONDITION") {
    const state = input.attentionStateId
      ? await prisma.attentionState.findFirst({ where: { id: input.attentionStateId, resolvedAt: null }, select: { id: true } })
      : null;
    if (!state) throw new Error("ATTENTION_NOT_ACTIVE");
    return;
  }
  if (input.scope === "NODE") {
    const node = input.nodeId ? await prisma.node.findUnique({ where: { id: input.nodeId }, select: { id: true } }) : null;
    if (!node) throw new Error("NOT_FOUND");
    return;
  }
  if (input.scope === "WORKLOAD") {
    const workload = input.workloadId
      ? await prisma.project.findUnique({ where: { id: input.workloadId }, select: { id: true } })
      : null;
    if (!workload) throw new Error("NOT_FOUND");
    return;
  }
  throw new Error("INVALID_SCOPE");
}

export async function createAttentionSilence(input: {
  scope: LifecycleScopeType;
  attentionStateId?: string | null;
  nodeId?: string | null;
  workloadId?: string | null;
  startsAt?: Date;
  endsAt: Date;
  reason?: string | null;
  actor: AuthSession;
  sourceIp?: string | null;
}) {
  const startsAt = input.startsAt ?? new Date();
  if (!(input.endsAt.getTime() > startsAt.getTime())) throw new Error("INVALID_TIME_RANGE");
  await assertScopeTarget(input);
  const silence = await prisma.attentionSilence.create({
    data: {
      scope: input.scope,
      attentionStateId: input.scope === "CONDITION" ? input.attentionStateId : null,
      nodeId: input.scope === "NODE" ? input.nodeId : null,
      workloadId: input.scope === "WORKLOAD" ? input.workloadId : null,
      createdById: input.actor.userId,
      reason: input.reason?.trim() || null,
      startsAt,
      endsAt: input.endsAt
    },
    include: { createdBy: { select: { displayName: true, email: true } } }
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "ATTENTION_NOTIFICATIONS_SILENCED",
    targetType: input.scope,
    targetId: input.attentionStateId ?? input.nodeId ?? input.workloadId ?? null,
    metadata: { silenceId: silence.id, startsAt: startsAt.toISOString(), endsAt: input.endsAt.toISOString(), hasReason: Boolean(silence.reason) },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return silence;
}

export async function cancelAttentionSilence(input: {
  silenceId: string;
  actor: AuthSession;
  sourceIp?: string | null;
}) {
  const existing = await prisma.attentionSilence.findUnique({ where: { id: input.silenceId } });
  if (!existing) throw new Error("NOT_FOUND");
  const now = new Date();
  await prisma.attentionSilence.updateMany({
    where: { id: existing.id, cancelledAt: null },
    data: { cancelledAt: now, cancelledById: input.actor.userId }
  });
  const current = await prisma.attentionSilence.findUniqueOrThrow({
    where: { id: existing.id },
    include: {
      createdBy: { select: { displayName: true, email: true } },
      cancelledBy: { select: { displayName: true, email: true } }
    }
  });
  if (!existing.cancelledAt) {
    await logAuditEvent({
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      actorRole: input.actor.role,
      action: "ATTENTION_SILENCE_CANCELLED",
      targetType: existing.scope,
      targetId: existing.attentionStateId ?? existing.nodeId ?? existing.workloadId,
      metadata: { silenceId: existing.id },
      result: "SUCCESS",
      sourceIp: input.sourceIp ?? null
    });
  }
  return current;
}

export async function scheduleMaintenance(input: {
  scope: "NODE" | "WORKLOAD";
  nodeId?: string | null;
  workloadId?: string | null;
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
  notificationBehavior?: "SUPPRESS" | "KEEP";
  actor: AuthSession;
  sourceIp?: string | null;
}) {
  if (!(input.endsAt.getTime() > input.startsAt.getTime())) throw new Error("INVALID_TIME_RANGE");
  await assertScopeTarget(input);
  const window = await prisma.maintenanceWindow.create({
    data: {
      scope: input.scope,
      nodeId: input.scope === "NODE" ? input.nodeId : null,
      workloadId: input.scope === "WORKLOAD" ? input.workloadId : null,
      createdById: input.actor.userId,
      reason: input.reason?.trim() || null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      notificationBehavior: input.notificationBehavior ?? "SUPPRESS"
    },
    include: { createdBy: { select: { displayName: true, email: true } } }
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "MAINTENANCE_SCHEDULED",
    targetType: input.scope,
    targetId: input.nodeId ?? input.workloadId ?? null,
    metadata: {
      maintenanceWindowId: window.id,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
      notificationBehavior: window.notificationBehavior,
      hasReason: Boolean(window.reason)
    },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return window;
}

export async function cancelMaintenance(input: {
  maintenanceWindowId: string;
  actor: AuthSession;
  sourceIp?: string | null;
}) {
  const existing = await prisma.maintenanceWindow.findUnique({ where: { id: input.maintenanceWindowId } });
  if (!existing) throw new Error("NOT_FOUND");
  await prisma.maintenanceWindow.updateMany({
    where: { id: existing.id, cancelledAt: null },
    data: { cancelledAt: new Date(), cancelledById: input.actor.userId }
  });
  const current = await prisma.maintenanceWindow.findUniqueOrThrow({
    where: { id: existing.id },
    include: {
      createdBy: { select: { displayName: true, email: true } },
      cancelledBy: { select: { displayName: true, email: true } }
    }
  });
  if (!existing.cancelledAt) {
    await logAuditEvent({
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      actorRole: input.actor.role,
      action: "MAINTENANCE_CANCELLED",
      targetType: existing.scope,
      targetId: existing.nodeId ?? existing.workloadId,
      metadata: { maintenanceWindowId: existing.id },
      result: "SUCCESS",
      sourceIp: input.sourceIp ?? null
    });
  }
  return current;
}

export async function listMaintenanceWindows(now = new Date()) {
  return prisma.maintenanceWindow.findMany({
    where: { cancelledAt: null, endsAt: { gt: now } },
    orderBy: [{ startsAt: "asc" }, { endsAt: "asc" }],
    include: {
      node: { select: { id: true, name: true } },
      workload: { select: { id: true, name: true } },
      createdBy: { select: { displayName: true, email: true } }
    }
  });
}

export async function listAttentionSilences(now = new Date()) {
  return prisma.attentionSilence.findMany({
    where: { cancelledAt: null, endsAt: { gt: now } },
    orderBy: [{ startsAt: "asc" }, { endsAt: "asc" }],
    include: {
      attentionState: { select: { id: true, title: true, conditionType: true, severity: true } },
      node: { select: { id: true, name: true } },
      workload: { select: { id: true, name: true } },
      createdBy: { select: { displayName: true, email: true } }
    }
  });
}

export type AttentionCenterFilters = {
  view?: "active" | "acknowledged" | "silenced" | "resolved";
  severity?: "CRITICAL" | "WARNING" | "INFO";
  conditionType?: string;
  nodeId?: string;
  workloadId?: string;
  maintenance?: "active" | "none";
  limit?: number;
};

export async function listAttentionCenter(filters: AttentionCenterFilters = {}, now = new Date()) {
  const resolved = filters.view === "resolved";
  const rows = await prisma.attentionState.findMany({
    where: {
      resolvedAt: resolved ? { not: null } : null,
      ...(filters.severity ? { severity: filters.severity } : {}),
      ...(filters.conditionType ? { conditionType: filters.conditionType } : {})
    },
    orderBy: resolved
      ? [{ resolvedAt: "desc" }, { lastObservedAt: "desc" }]
      : [{ severity: "asc" }, { lastObservedAt: "desc" }],
    take: Math.min(filters.limit ?? 100, 200),
    include: {
      acknowledgements: {
        orderBy: { acknowledgedAt: "desc" },
        include: acknowledgementInclude
      }
    }
  });

  const contexts = await getLifecyclePolicyContexts(rows, now);
  const output = [];
  for (const row of rows) {
    const context = contexts.get(row.id)!;
    const acknowledgement = row.acknowledgements.find((ack) => !ack.clearedAt) ?? null;
    if (filters.view === "acknowledged" && !acknowledgement) continue;
    if (filters.view === "silenced" && context.activeSilences.length === 0) continue;
    if (filters.nodeId && context.nodeId !== filters.nodeId) continue;
    if (filters.workloadId && context.workloadId !== filters.workloadId) continue;
    if (filters.maintenance === "active" && context.activeMaintenance.length === 0) continue;
    if (filters.maintenance === "none" && context.activeMaintenance.length > 0) continue;
    output.push({
      ...row,
      acknowledgement,
      activeSilences: context.activeSilences,
      activeMaintenance: context.activeMaintenance,
      notificationsSuppressed: context.notificationsSuppressed,
      nodeId: context.nodeId,
      workloadId: context.workloadId
    });
  }
  return output;
}

export async function getAttentionDetail(attentionStateId: string, now = new Date()) {
  const state = await prisma.attentionState.findUnique({
    where: { id: attentionStateId },
    include: {
      acknowledgements: {
        orderBy: { acknowledgedAt: "desc" },
        include: acknowledgementInclude
      },
      silences: {
        orderBy: { createdAt: "desc" },
        include: {
          createdBy: { select: { displayName: true, email: true } },
          cancelledBy: { select: { displayName: true, email: true } }
        }
      }
    }
  });
  if (!state) return null;
  const [context, activity] = await Promise.all([
    getLifecyclePolicyContext(state, now),
    prisma.auditLog.findMany({
      where: { targetType: state.resourceType, targetId: state.resourceId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        action: true,
        actorEmail: true,
        result: true,
        metadata: true,
        createdAt: true
      }
    })
  ]);
  return {
    ...state,
    acknowledgement: state.acknowledgements.find((ack) => !ack.clearedAt) ?? null,
    nodeId: context.nodeId,
    workloadId: context.workloadId,
    lifecycle: context,
    recentActivity: activity
  };
}

export async function clearAcknowledgementsForResolvedState(attentionStateId: string, at: Date): Promise<void> {
  await prisma.attentionAcknowledgement.updateMany({
    where: { attentionStateId, clearedAt: null },
    data: { clearedAt: at, clearedReason: "condition_resolved" }
  });
}
