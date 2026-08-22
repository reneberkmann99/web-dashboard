import { z } from "zod";

/**
 * Phase 5: domains, public addresses, ingress providers, ingress endpoints.
 */

const nullableId = z.string().cuid().nullable().optional();

// One DNS label: alphanumeric, internal hyphens only, 1-63 chars. A hostname
// is 1+ labels joined by dots, lowercase (DNS is case-insensitive; we
// normalize to lowercase so lookups and uniqueness are consistent).
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const hostnameSchema = z.string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .refine((value) => value.split(".").length >= 2 && value.split(".").every((label) => DNS_LABEL.test(label)), {
    message: "Must be a valid fully-qualified hostname (e.g. app.example.com)"
  });

export const domainCreateSchema = z.object({
  hostname: hostnameSchema,
  clientAccountId: nullableId
}).strict();

const port = z.number().int().min(1).max(65535);

export const publicAddressCreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  ipAddress: z.string().trim().min(2).max(64),
  ipVersion: z.enum(["V4", "V6"]),
  allocation: z.enum(["SHARED", "DEDICATED"]).optional(),
  enabled: z.boolean().optional(),
  reservedForOrgId: nullableId,
  providerId: nullableId
}).strict();

export const publicAddressUpdateSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  allocation: z.enum(["SHARED", "DEDICATED"]).optional(),
  reservedForOrgId: nullableId,
  providerId: nullableId
}).strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required");

export const ingressProviderCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["MANUAL", "NGINX_PROXY_MANAGER", "CADDY"]).optional(),
  enabled: z.boolean().optional(),
  gatewayHostname: hostnameSchema.nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  credential: z.string().min(1).max(4096).nullable().optional()
}).strict();

export const ingressProviderUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  gatewayHostname: hostnameSchema.nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  credential: z.string().min(1).max(4096).nullable().optional()
}).strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required");

export const ingressEndpointCreateSchema = z.object({
  clientAccountId: nullableId,
  workloadId: z.string().cuid(),
  containerId: nullableId,
  serviceName: z.string().trim().min(1).max(100).nullable().optional(),
  targetPort: port,
  exposureType: z.enum(["HTTPS", "HTTP", "TCP", "UDP"]),
  domainId: nullableId,
  publicAddressId: z.string().cuid(),
  publicPort: port.nullable().optional(),
  providerId: nullableId
}).strict()
  .refine((body) => Boolean(body.containerId) || Boolean(body.serviceName), {
    message: "containerId or serviceName is required so a gateway has something to route to",
    path: ["containerId"]
  });

export const ingressEndpointUpdateSchema = z.object({
  containerId: nullableId,
  serviceName: z.string().trim().min(1).max(100).nullable().optional(),
  targetPort: port.optional(),
  providerId: nullableId,
  status: z.enum(["PENDING", "ACTIVE", "BACKEND_UNAVAILABLE", "DNS_INVALID", "TLS_FAILED", "DISABLED"]).optional(),
  statusDetail: z.string().trim().max(1000).nullable().optional()
}).strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required");
