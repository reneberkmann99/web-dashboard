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
  "TEST_NOTIFICATION",
  "DEPLOYMENT_FAILED",
  "DEPLOYMENT_SUCCEEDED"
]);

const emailField = z.string().trim().toLowerCase().email().max(254);

export const notificationDestinationCreateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("WEBHOOK"),
    name: z.string().trim().min(1).max(100),
    url: z.string().trim().url().max(4096),
    authHeader: z.string().max(2048).nullable().optional(),
    signingSecret: z.string().min(16).max(1024),
    enabled: z.boolean().optional(),
    clientAccountId: z.string().cuid().nullable().optional()
  }).strict(),
  z.object({
    type: z.literal("EMAIL"),
    name: z.string().trim().min(1).max(100),
    emailRecipients: z.array(emailField).min(1).max(20),
    enabled: z.boolean().optional(),
    clientAccountId: z.string().cuid().nullable().optional()
  }).strict()
]);

export const notificationDestinationUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  url: z.string().trim().url().max(4096).optional(),
  authHeader: z.string().max(2048).nullable().optional(),
  signingSecret: z.string().min(16).max(1024).optional(),
  emailRecipients: z.array(emailField).min(1).max(20).optional()
}).strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required");

export const notificationRuleCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["PLATFORM", "ORGANIZATION"]),
  clientAccountId: z.string().cuid().nullable().optional(),
  eventTypes: z.array(notificationEventTypeSchema).min(1).max(7),
  minSeverity: z.enum(["INFO", "WARNING", "CRITICAL"]).optional(),
  destinationId: z.string().cuid(),
  enabled: z.boolean().optional()
}).strict();

export const notificationRuleUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  eventTypes: z.array(notificationEventTypeSchema).min(1).max(7).optional(),
  minSeverity: z.enum(["INFO", "WARNING", "CRITICAL"]).optional(),
  destinationId: z.string().cuid().optional(),
  enabled: z.boolean().optional()
}).strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required");
