import { z } from "zod";

/**
 * Security: validates that route :id params are valid CUIDs.
 * Prevents arbitrary string injection into Prisma queries and agent calls.
 */
export const cuidParamSchema = z.string().cuid();

export const createClientSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/),
  isActive: z.boolean().optional()
});

export const updateClientSchema = createClientSchema.partial();

export const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(100),
  password: z.string().min(8).max(128),
  role: z.enum(["ADMIN", "CLIENT"]),
  clientAccountId: z.string().cuid().nullable().optional(),
  isActive: z.boolean().optional()
});

export const updateUserSchema = z.object({
  displayName: z.string().min(2).max(100).optional(),
  role: z.enum(["ADMIN", "CLIENT"]).optional(),
  clientAccountId: z.string().cuid().nullable().optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(128).optional()
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

export const createAssignmentSchema = z.object({
  clientAccountId: z.string().cuid(),
  projectId: z.string().cuid().nullable().optional(),
  nodeId: z.string().cuid(),
  dockerContainerId: z.string().min(2).max(128),
  dockerName: z.string().min(1).max(255),
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

export const containerActionSchema = z.object({
  action: z.enum(["start", "stop", "restart"])
});
