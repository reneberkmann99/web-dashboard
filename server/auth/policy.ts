import { Role } from "@prisma/client";
import { isClientRole } from "@/types/domain";
import type { AuthSession } from "@/server/auth/session";

/**
 * Server-side capability model.
 *
 * Capabilities are the atomic unit of authorization. Roles map to sets of
 * capabilities; every privileged action in the codebase is gated by an
 * explicit `can(...)` check, never by a bare `role === "X"` comparison
 * scattered through route handlers.
 *
 * Capability reference (see also the brief):
 *   platform.admin            — full platform administration (users, clients, nodes, audit)
 *   client.manage             — manage a client account (its users/projects/grants)
 *   user.manage               — manage users (platform-wide for ADMIN, own client for CLIENT_ADMIN)
 *   node.manage               — register/configure nodes (ADMIN only by construction)
 *   project.view              — see the workloads of the caller's client
 *   container.view            — see container inventory of the caller's client
 *   container.view_logs       — read container logs
 *   container.start           — start a granted container
 *   container.stop            — stop a granted container
 *   container.restart         — restart a granted container
 *
 * Node administration is deliberately NOT granted to any client role.
 */

export type Capability =
  | "platform.admin"
  | "client.manage"
  | "user.manage"
  | "node.manage"
  | "project.view"
  | "project.create"
  | "container.view"
  | "container.view_logs"
  | "container.start"
  | "container.stop"
  | "container.restart"
  | "deployment.view"
  | "deployment.manage"
  | "deployment.deploy";

const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  ADMIN: [
    "platform.admin",
    "client.manage",
    "user.manage",
    "node.manage",
    "project.view",
    "project.create",
    "container.view",
    "container.view_logs",
    "container.start",
    "container.stop",
    "container.restart",
    "deployment.view",
    "deployment.manage",
    "deployment.deploy"
  ],
  // Deprecated legacy value retained for migration safety; treated as operator.
  CLIENT: [
    "project.view",
    "project.create",
    "container.view",
    "container.view_logs",
    "container.start",
    "container.stop",
    "container.restart",
    "deployment.view",
    "deployment.manage",
    "deployment.deploy"
  ],
  CLIENT_ADMIN: [
    "client.manage",
    "user.manage",
    "project.view",
    "project.create",
    "container.view",
    "container.view_logs",
    "container.start",
    "container.stop",
    "container.restart",
    "deployment.view",
    "deployment.manage",
    "deployment.deploy"
  ],
  CLIENT_OPERATOR: [
    "project.view",
    "project.create",
    "container.view",
    "container.view_logs",
    "container.start",
    "container.stop",
    "container.restart",
    "deployment.view",
    "deployment.manage",
    "deployment.deploy"
  ],
  CLIENT_VIEWER: [
    "project.view",
    "container.view",
    "container.view_logs",
    "deployment.view"
  ]
};

export function capabilitiesForRole(role: Role): Capability[] {
  return ROLE_CAPABILITIES[role] ?? [];
}

export function can(session: AuthSession, capability: Capability): boolean {
  return capabilitiesForRole(session.role).includes(capability);
}

/** Convenience: throws FORBIDDEN unless the session has the capability. */
export function ensureCan(session: AuthSession, capability: Capability): void {
  if (!can(session, capability)) {
    throw new Error("FORBIDDEN");
  }
}

/** True if the session is a tenant-scoped (client) role. */
export function isTenantSession(session: AuthSession): boolean {
  return isClientRole(session.role);
}
