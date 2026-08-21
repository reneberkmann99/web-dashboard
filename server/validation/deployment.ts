import { z } from "zod";

/**
 * Validation schemas for managed-deployment authoring (Phase 6A).
 * All authoring is ADMIN-only (enforced at the route layer).
 */

export const envKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

export const environmentSchema = z
  .record(z.string().min(1), z.string().max(8192))
  .refine((env) => Object.keys(env).length <= 200, {
    message: "At most 200 environment variables are supported"
  });

export const secretReferencesSchema = z
  .array(envKeySchema)
  .max(200);

export const composeSchema = z.string().min(1).max(200_000);

export const composeProjectNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Compose project name must be lowercase alphanumeric with -/_");

export const validateDeploymentSchema = z
  .object({
    nodeId: z.string().cuid(),
    compose: composeSchema,
    environment: environmentSchema.default({}),
    secretReferences: secretReferencesSchema.default([])
  })
  .refine(
    (v) => {
      const envKeys = new Set(Object.keys(v.environment));
      return v.secretReferences.every((k) => !envKeys.has(k));
    },
    { message: "A key cannot be both a non-secret environment variable and a secret reference", path: ["secretReferences"] }
  );

export const createDeploymentSchema = z
  .object({
    nodeId: z.string().cuid(),
    name: z.string().min(2).max(120),
    slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/).optional(),
    description: z.string().max(500).nullable().optional(),
    clientAccountId: z.string().cuid().nullable().optional(),
    composeProjectName: composeProjectNameSchema,
    compose: composeSchema,
    environment: environmentSchema.default({}),
    secretReferences: secretReferencesSchema.default([]),
    acknowledgedFindings: z.array(z.string()).default([]),
    deployNote: z.string().max(500).nullable().optional()
  })
  .refine(
    (v) => {
      const envKeys = new Set(Object.keys(v.environment));
      return v.secretReferences.every((k) => !envKeys.has(k));
    },
    { message: "A key cannot be both a non-secret environment variable and a secret reference", path: ["secretReferences"] }
  );

export const createRevisionSchema = z
  .object({
    compose: composeSchema,
    environment: environmentSchema.default({}),
    secretReferences: secretReferencesSchema.default([]),
    acknowledgedFindings: z.array(z.string()).default([]),
    deployNote: z.string().max(500).nullable().optional()
  })
  .refine(
    (v) => {
      const envKeys = new Set(Object.keys(v.environment));
      return v.secretReferences.every((k) => !envKeys.has(k));
    },
    { message: "A key cannot be both a non-secret environment variable and a secret reference", path: ["secretReferences"] }
  );

export const acknowledgeFindingSchema = z.object({
  fingerprint: z.string().min(16).max(128)
});

export const createSecretSchema = z.object({
  key: envKeySchema,
  value: z.string().min(1).max(8192)
});

export const rotateSecretSchema = z.object({
  value: z.string().min(1).max(8192)
});

export const patchSecretSchema = z.object({
  isActive: z.boolean()
});

export const planSchema = z.object({
  revisionId: z.string().cuid().optional()
});

export const deploySchema = z.object({
  revisionId: z.string().cuid(),
  planHash: z.string().min(16).max(128)
});

export const rollbackSchema = z.object({
  revisionId: z.string().cuid().optional(),
  planHash: z.string().min(16).max(128)
});

/**
 * Compose service name as it appears in a URL path segment. Deliberately
 * stricter than Compose itself (no slashes, no traversal) so a service name can
 * never be used to escape the route.
 */
export const serviceNameParamSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Invalid service name");
