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
 * Capability reference:
 *   platform.admin            — full platform administration (users, clients, nodes, audit)
 *   client.manage             — manage a client account (its users/projects/grants)
 *   user.manage               — manage users (platform-wide for ADMIN, own client for CLIENT_ADMIN)
 *   node.manage               — register/configure nodes (ADMIN only by construction)
 *
 *   workload.view             — see workloads (and their configuration/history)
 *   workload.create           — create new workloads
 *   workload.edit             — change a workload's configuration (new revisions)
 *   workload.deploy           — apply configuration to the runtime (deploy/rollback)
 *   workload.adopt            — bring existing Docker resources under management
 *   workload.delete           — deactivate / unmanage / delete a workload
 *
 *   container.view            — see container inventory
 *   container.view_logs       — read container logs
 *   container.edit            — change a container's configuration (managed: via workload)
 *   container.start           — start a granted container
 *   container.stop            — stop a granted container
 *   container.restart         — restart a granted container
 *   container.delete          — remove a standalone container
 *
 *   secrets.manage            — create/rotate deployment secrets
 *
 *   domain.view/manage        — see / add-verify-disable an organization's domains
 *   ingress.view/manage       — see / create-update-delete an organization's ingress endpoints
 *   public_address.manage     — platform-only: manage WAN/public IPs
 *   ingress_provider.manage   — platform-only: manage ingress/gateway providers
 *
 * Legacy aliases (`project.view`, `project.create`, `deployment.view`,
 * `deployment.manage`, `deployment.deploy`) are retained so existing route
 * handlers keep compiling; they resolve to the granular capabilities above.
 *
 * Role intent:
 *   ADMIN           — everything.
 *   CLIENT_ADMIN    — operator rights + configuration editing, deploying,
 *                     secrets, and user management inside their own client.
 *   CLIENT_OPERATOR — view + permitted RUNTIME actions (start/stop/restart,
 *                     logs). Explicitly NOT allowed to change configuration,
 *                     deploy, or manage secrets.
 *   CLIENT_VIEWER   — read only.
 *
 * Node administration is deliberately NOT granted to any client role.
 */

export type Capability =
  | "platform.admin"
  | "client.manage"
  | "user.manage"
  | "node.manage"
  // Workload lifecycle
  | "workload.view"
  | "workload.create"
  | "workload.edit"
  | "workload.deploy"
  | "workload.adopt"
  | "workload.delete"
  // Container lifecycle
  | "container.view"
  | "container.view_logs"
  | "container.edit"
  | "container.start"
  | "container.stop"
  | "container.restart"
  | "container.delete"
  // Secrets
  | "secrets.manage"
  // Alerting (Phase 4): destinations/rules. ADMIN manages platform-wide and
  // any organization's; CLIENT_ADMIN manages only their own organization's
  // (server/services/notifications.ts is the sole scope-enforcement point —
  // this capability alone does not imply platform scope).
  | "alerting.manage"
  // Domains & ingress (Phase 5). domain.*/ingress.* are organization-scoped —
  // ADMIN manages any organization's, CLIENT_ADMIN only their own
  // (server/services/domains.ts and server/services/ingress.ts are the sole
  // scope-enforcement points, same pattern as alerting.manage). view-only
  // capabilities are granted to every client role so an operator/viewer can
  // see what's published without being able to change it.
  | "domain.view"
  | "domain.manage"
  | "ingress.view"
  | "ingress.manage"
  // Platform-only (Phase 5): never granted to any client role. Organization
  // users must not see platform Public Address / Provider management.
  | "public_address.manage"
  | "ingress_provider.manage"
  // Legacy aliases (kept for existing call sites)
  | "project.view"
  | "project.create"
  | "deployment.view"
  | "deployment.manage"
  | "deployment.deploy";

/** Read-only capabilities every client role has. */
const VIEWER_CAPABILITIES: Capability[] = [
  "workload.view",
  "project.view",
  "container.view",
  "container.view_logs",
  "deployment.view",
  "domain.view",
  "ingress.view"
];

/** Runtime actions an operator may perform without editing configuration. */
const OPERATOR_RUNTIME_CAPABILITIES: Capability[] = [
  "container.start",
  "container.stop",
  "container.restart"
];

/** Configuration authoring/deploy rights. */
const EDITOR_CAPABILITIES: Capability[] = [
  "workload.create",
  "workload.edit",
  "workload.deploy",
  "workload.delete",
  "container.edit",
  "container.delete",
  "secrets.manage",
  "project.create",
  "deployment.manage",
  "deployment.deploy"
];

const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  ADMIN: [
    "platform.admin",
    "client.manage",
    "user.manage",
    "node.manage",
    "workload.adopt",
    "alerting.manage",
    "domain.manage",
    "ingress.manage",
    "public_address.manage",
    "ingress_provider.manage",
    ...VIEWER_CAPABILITIES,
    ...OPERATOR_RUNTIME_CAPABILITIES,
    ...EDITOR_CAPABILITIES
  ],
  // Deprecated legacy value retained for migration safety; treated as a
  // client admin (its historical grant set).
  CLIENT: [...VIEWER_CAPABILITIES, ...OPERATOR_RUNTIME_CAPABILITIES, ...EDITOR_CAPABILITIES],
  CLIENT_ADMIN: [
    "client.manage",
    "user.manage",
    "alerting.manage",
    "domain.manage",
    "ingress.manage",
    ...VIEWER_CAPABILITIES,
    ...OPERATOR_RUNTIME_CAPABILITIES,
    ...EDITOR_CAPABILITIES
  ],
  // Operator: runtime actions only — no configuration edit, no deploy, no secrets.
  CLIENT_OPERATOR: [...VIEWER_CAPABILITIES, ...OPERATOR_RUNTIME_CAPABILITIES],
  CLIENT_VIEWER: [...VIEWER_CAPABILITIES]
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
