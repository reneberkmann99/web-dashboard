import { z } from "zod";

/**
 * Security: validates that route :id params are valid CUIDs.
 * Prevents arbitrary string injection into Prisma queries and agent calls.
 */
export const cuidParamSchema = z.string().cuid();

export const roleSchema = z.enum(["ADMIN", "CLIENT_ADMIN", "CLIENT_OPERATOR", "CLIENT_VIEWER"]);

export const createClientSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/),
  isActive: z.boolean().optional()
});

export const updateClientSchema = createClientSchema.partial();

/**
 * User creation no longer accepts a password. The admin creates a pending
 * user; Noderaft generates a one-time activation token; the user sets their
 * own password. No default or example passwords anywhere.
 */
export const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(100),
  role: roleSchema,
  clientAccountId: z.string().cuid().nullable().optional(),
  isActive: z.boolean().optional()
});

export const updateUserSchema = z.object({
  displayName: z.string().min(2).max(100).optional(),
  role: roleSchema.optional(),
  clientAccountId: z.string().cuid().nullable().optional(),
  isActive: z.boolean().optional()
});

/** Activation: user sets their own password using a one-time token. */
export const activateAccountSchema = z.object({
  token: z.string().min(16).max(512),
  password: z.string().min(12).max(128).regex(/[a-zA-Z]/, "Must contain at least one letter")
    .regex(/\d/, "Must contain at least one digit")
});

/** Self-service profile update: display name only (role/client are admin-managed). */
export const updateSelfSchema = z.object({
  displayName: z.string().min(2).max(100)
});

/** Self-service password change (LOCAL accounts only). */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(128).regex(/[a-zA-Z]/, "Must contain at least one letter")
    .regex(/\d/, "Must contain at least one digit")
}).refine((v) => v.currentPassword !== v.newPassword, {
  message: "New password must differ from the current password",
  path: ["newPassword"]
});

export const createNodeSchema = z.object({
  name: z.string().min(2).max(120),
  hostname: z.string().min(2).max(255),
  apiBaseUrl: z.string().url(),
  apiKey: z.string().min(8).max(512),
  dockerContext: z.string().max(255).optional(),
  isActive: z.boolean().optional()
});

export const updateNodeSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  hostname: z.string().min(2).max(255).optional(),
  apiBaseUrl: z.string().url().optional(),
  apiKey: z.string().min(8).max(512).optional(),
  dockerContext: z.string().max(255).optional(),
  isActive: z.boolean().optional()
});

/**
 * Assignment creation references a discovered container (by node +
 * dockerContainerId) — never a hand-typed free-form id. `dockerName`/`image`
 * are auto-filled from the agent's inventory when omitted.
 */
export const createAssignmentSchema = z.object({
  clientAccountId: z.string().cuid(),
  projectId: z.string().cuid().nullable().optional(),
  nodeId: z.string().cuid(),
  dockerContainerId: z.string().min(2).max(128),
  dockerName: z.string().min(1).max(255).optional(),
  image: z.string().max(255).optional(),
  friendlyLabel: z.string().max(255).optional(),
  allowedActions: z.array(z.enum(["start", "stop", "restart"]))
});

export const updateAssignmentSchema = z.object({
  clientAccountId: z.string().cuid().optional(),
  projectId: z.string().cuid().nullable().optional(),
  friendlyLabel: z.string().max(255).nullable().optional(),
  allowedActions: z.array(z.enum(["start", "stop", "restart"])).optional(),
  isActive: z.boolean().optional()
});

export const createProjectSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/),
  description: z.string().max(500).nullable().optional(),
  // Nullable: a workload may be internal (no client) until explicitly granted.
  clientAccountId: z.string().cuid().nullable().optional(),
  nodeId: z.string().cuid(),
  isActive: z.boolean().optional()
});

export const updateProjectSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(500).nullable().optional(),
  clientAccountId: z.string().cuid().nullable().optional(),
  nodeId: z.string().cuid().optional(),
  isActive: z.boolean().optional()
});

export const createGrantSchema = z.object({
  clientAccountId: z.string().cuid(),
  // Exactly one of projectId / containerId must be provided.
  projectId: z.string().cuid().nullable().optional(),
  containerId: z.string().cuid().nullable().optional(),
  allowedActions: z.array(z.enum(["start", "stop", "restart", "view_logs"])).min(1),
  isActive: z.boolean().optional()
}).refine((v) => Boolean(v.projectId) !== Boolean(v.containerId), {
  message: "Provide exactly one of projectId or containerId",
  path: ["projectId"]
});

export const updateGrantSchema = z.object({
  allowedActions: z.array(z.enum(["start", "stop", "restart", "view_logs"])).min(1).optional(),
  isActive: z.boolean().optional()
});

export const containerActionSchema = z.object({
  action: z.enum(["start", "stop", "restart"])
});

/** CLIENT_ADMIN inviting a user to their own client (operators/viewers only). */
export const inviteClientUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(100),
  role: z.enum(["CLIENT_OPERATOR", "CLIENT_VIEWER"])
});
