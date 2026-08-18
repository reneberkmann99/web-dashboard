import crypto from "node:crypto";
import { OperationState, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import type { AuthSession } from "@/server/auth/session";
import type { OperationView } from "@/types/domain";

/**
 * Operation lifecycle service.
 *
 * Container start/stop/restart are never performed synchronously inside an
 * HTTP handler anymore. A request creates an `Operation` row in REQUESTED
 * state, an executor transitions it QUEUED → RUNNING → SUCCEEDED/FAILED, and
 * clients poll for the outcome. At most one active operation per container is
 * enforced by a partial unique index (see migration step2_domain_model).
 */

export type OperationType = "CONTAINER_START" | "CONTAINER_STOP" | "CONTAINER_RESTART";

export type RequestOperationInput = {
  type: OperationType;
  actor: AuthSession;
  clientAccountId: string | null;
  nodeId: string;
  dockerContainerId: string;
  containerId?: string | null;
  targetAssignmentId?: string | null;
  sourceIp?: string | null;
};

export class OperationConflictError extends Error {
  constructor(public existingOperationId: string) {
    super("An operation is already in progress for this container");
    this.name = "OperationConflictError";
  }
}

function toOperationView(op: {
  id: string;
  type: string;
  state: OperationState;
  requestId: string;
  actorEmail: string | null;
  actorRole: Prisma.OperationGetPayload<{ select: { actorRole: true } }>["actorRole"];
  node: { name: string };
  dockerContainerId: string;
  error: string | null;
  requestedAt: Date;
  queuedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}): OperationView {
  return {
    id: op.id,
    type: op.type,
    state: op.state,
    requestId: op.requestId,
    actorEmail: op.actorEmail,
    actorRole: op.actorRole,
    nodeName: op.node.name,
    dockerContainerId: op.dockerContainerId,
    error: op.error,
    requestedAt: op.requestedAt.toISOString(),
    queuedAt: op.queuedAt?.toISOString() ?? null,
    startedAt: op.startedAt?.toISOString() ?? null,
    finishedAt: op.finishedAt?.toISOString() ?? null
  };
}

/**
 * Create the operation row. Throws OperationConflictError when a
 * REQUESTED/QUEUED/RUNNING operation already exists for the same container
 * (unique partial index).
 */
export async function requestOperation(input: RequestOperationInput): Promise<string> {
  let created: { id: string };
  try {
    created = await prisma.operation.create({
      data: {
        type: input.type,
        state: "REQUESTED",
        requestId: crypto.randomUUID(),
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        actorRole: input.actor.role,
        clientAccountId: input.clientAccountId,
        nodeId: input.nodeId,
        dockerContainerId: input.dockerContainerId,
        containerId: input.containerId ?? null,
        targetAssignmentId: input.targetAssignmentId ?? null,
        requestedAt: new Date()
      },
      select: { id: true }
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Find the conflicting active operation to surface a helpful message.
      const conflicting = await prisma.operation.findFirst({
        where: {
          dockerContainerId: input.dockerContainerId,
          state: { in: ["REQUESTED", "QUEUED", "RUNNING"] }
        },
        select: { id: true }
      });
      throw new OperationConflictError(conflicting?.id ?? "unknown");
    }
    throw error;
  }

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: `${input.type}_REQUESTED`,
    targetType: "OPERATION",
    targetId: created.id,
    metadata: {
      dockerContainerId: input.dockerContainerId,
      nodeId: input.nodeId,
      clientAccountId: input.clientAccountId
    },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  // Execute in the background; the HTTP handler returns immediately with the
  // operation id and the caller polls for state transitions.
  void executeOperation(created.id);
  return created.id;
}

/**
 * Run a single operation to completion: QUEUED → RUNNING → SUCCEEDED/FAILED.
 * Safe to call more than once (idempotent for terminal states).
 */
export async function executeOperation(operationId: string): Promise<void> {
  const operation = await prisma.operation.findUnique({
    where: { id: operationId },
    include: { node: true }
  });
  if (!operation) {
    return;
  }
  if (operation.state === "SUCCEEDED" || operation.state === "FAILED" || operation.state === "CANCELLED") {
    return;
  }

  const action = operation.type.replace("CONTAINER_", "").toLowerCase() as "start" | "stop" | "restart";

  await prisma.operation.update({
    where: { id: operation.id },
    data: { state: "QUEUED", queuedAt: new Date() }
  });
  await prisma.operation.update({
    where: { id: operation.id },
    data: { state: "RUNNING", startedAt: new Date() }
  });

  try {
    const success = await nodeAgentClient.runAction(operation.node, operation.dockerContainerId, action);
    if (!success) {
      throw new Error("Agent rejected the action");
    }
    await prisma.operation.update({
      where: { id: operation.id },
      data: { state: "SUCCEEDED", finishedAt: new Date(), error: null }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    await prisma.operation.update({
      where: { id: operation.id },
      data: { state: "FAILED", finishedAt: new Date(), error: message.slice(0, 1000) }
    });
  }

  const finalOp = await prisma.operation.findUniqueOrThrow({
    where: { id: operation.id },
    select: { state: true, error: true, type: true }
  });

  await logAuditEvent({
    actorUserId: operation.actorUserId,
    actorEmail: operation.actorEmail,
    actorRole: operation.actorRole,
    action: `${operation.type}_${finalOp.state}`,
    targetType: "OPERATION",
    targetId: operation.id,
    metadata: {
      dockerContainerId: operation.dockerContainerId,
      nodeId: operation.nodeId,
      clientAccountId: operation.clientAccountId,
      error: finalOp.error
    },
    result: finalOp.state === "SUCCEEDED" ? "SUCCESS" : "FAILURE"
  });
}

export async function getOperationForSession(session: AuthSession, operationId: string): Promise<OperationView | null> {
  const op = await prisma.operation.findFirst({
    where: {
      id: operationId,
      ...(session.role === "ADMIN"
        ? {}
        : {
            OR: [{ clientAccountId: session.clientAccountId ?? "__invalid__" }, { actorUserId: session.userId }]
          })
    },
    include: { node: { select: { name: true } } }
  });
  return op ? toOperationView(op) : null;
}

export async function listOperationsForSession(
  session: AuthSession,
  limit = 20
): Promise<OperationView[]> {
  const ops = await prisma.operation.findMany({
    where:
      session.role === "ADMIN"
        ? {}
        : {
            OR: [{ clientAccountId: session.clientAccountId ?? "__invalid__" }, { actorUserId: session.userId }]
          },
    orderBy: { requestedAt: "desc" },
    take: Math.min(limit, 100),
    include: { node: { select: { name: true } } }
  });
  return ops.map(toOperationView);
}
