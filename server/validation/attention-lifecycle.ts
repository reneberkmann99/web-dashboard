import { z } from "zod";

const nullableId = z.string().cuid().nullable().optional();
const dateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const acknowledgementSchema = z.object({
  note: z.string().trim().max(1000).nullable().optional()
}).strict();

export const silenceSchema = z.object({
  scope: z.enum(["CONDITION", "NODE", "WORKLOAD"]),
  attentionStateId: nullableId,
  nodeId: nullableId,
  workloadId: nullableId,
  startsAt: dateTime.optional(),
  endsAt: dateTime,
  reason: z.string().trim().max(1000).nullable().optional()
}).strict();

export const maintenanceSchema = z.object({
  scope: z.enum(["NODE", "WORKLOAD"]),
  nodeId: nullableId,
  workloadId: nullableId,
  startsAt: dateTime,
  endsAt: dateTime,
  reason: z.string().trim().max(1000).nullable().optional(),
  notificationBehavior: z.enum(["SUPPRESS", "KEEP"]).default("SUPPRESS")
}).strict();

export const notificationEventTypeSchema = z.enum([
  "CONDITION_OPENED",
  "SEVERITY_ESCALATED",
  "CONDITION_RESOLVED",
  "SILENCE_EXPIRED_STILL_ACTIVE",
  "TEST_NOTIFICATION"
]);

export const notificationDestinationCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().url().max(4096),
  authHeader: z.string().max(2048).nullable().optional(),
  signingSecret: z.string().min(16).max(1024),
  enabled: z.boolean().optional(),
  minSeverity: z.enum(["INFO", "WARNING", "CRITICAL"]).optional(),
  eventTypes: z.array(notificationEventTypeSchema).min(1).max(5),
  scopeNodeIds: z.array(z.string().cuid()).max(100).optional(),
  scopeWorkloadIds: z.array(z.string().cuid()).max(100).optional()
}).strict();

export const notificationDestinationUpdateSchema = notificationDestinationCreateSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required");
