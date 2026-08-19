import { z } from "zod";

export const containerDetailsSchema = z.object({
  restartPolicy: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  networks: z
    .array(
      z.object({
        name: z.string(),
        ipAddress: z.string(),
        gateway: z.string()
      })
    )
    .optional(),
  mounts: z
    .array(
      z.object({
        type: z.string(),
        source: z.string(),
        destination: z.string(),
        mode: z.string()
      })
    )
    .optional(),
  imageId: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  health: z.string().nullable().optional()
});

export const containerRuntimeSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  status: z.enum(["running", "stopped", "restarting", "unhealthy", "unknown"]),
  uptime: z.string().nullable(),
  ports: z.string(),
  createdAt: z.string().nullable(),
  cpuPercent: z.number().nullable(),
  memoryUsage: z.string().nullable(),
  restartCount: z.number().nullable(),
  lastUpdatedAt: z.string(),
  composeProject: z.string().nullable().optional(),
  composeService: z.string().nullable().optional(),
  networkNames: z.array(z.string()).optional(),
  mountRefs: z
    .array(
      z.object({
        type: z.string(),
        source: z.string(),
        destination: z.string(),
        mode: z.string(),
        volumeName: z.string().nullable()
      })
    )
    .optional(),
  details: containerDetailsSchema.nullable().optional()
});

export const listContainersResponseSchema = z.object({
  nodeOnline: z.boolean(),
  containers: z.array(containerRuntimeSchema)
});

export const containerDetailResponseSchema = z.object({
  nodeOnline: z.boolean(),
  container: containerRuntimeSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const containerLogsResponseSchema = z.object({
  nodeOnline: z.boolean(),
  logs: z.array(z.string())
});

export const storageSummaryEntrySchema = z.object({
  type: z.string(),
  totalCount: z.number(),
  active: z.number(),
  size: z.string(),
  reclaimable: z.string()
});

export const storageSummaryResponseSchema = z.object({
  nodeOnline: z.boolean(),
  summary: z.array(storageSummaryEntrySchema)
});

export const networkInfoSchema = z.object({
  name: z.string(),
  id: z.string(),
  driver: z.string(),
  scope: z.string(),
  internal: z.boolean(),
  subnets: z.array(z.string()),
  gateways: z.array(z.string()),
  attachedContainers: z.array(z.string())
});

export const networksInspectResponseSchema = z.object({
  nodeOnline: z.boolean(),
  networks: z.array(networkInfoSchema)
});

export const volumeInfoSchema = z.object({
  name: z.string(),
  driver: z.string(),
  mountpoint: z.string().nullable()
});

export const volumesInspectResponseSchema = z.object({
  nodeOnline: z.boolean(),
  volumes: z.array(volumeInfoSchema)
});

export const composeValidationResponseSchema = z.object({
  nodeOnline: z.boolean(),
  composeSupported: z.boolean(),
  composeVersion: z.string().nullable(),
  valid: z.boolean(),
  errors: z.array(z.string()),
  normalized: z.string().nullable()
});

// --- Managed deployment execution contract (Phase 6B) ---

export const deploymentPreparedResponseSchema = z.object({
  ok: z.boolean(),
  prepared: z.boolean(),
  revisionNumber: z.number().int().positive(),
  error: z.string().nullable().optional()
});

export const deploymentPullResponseSchema = z.object({
  ok: z.boolean(),
  images: z.array(z.object({ serviceName: z.string(), imageRef: z.string(), digest: z.string().nullable() })),
  error: z.string().nullable().optional()
});

export const deploymentApplyResponseSchema = z.object({
  ok: z.boolean(),
  applied: z.boolean(),
  error: z.string().nullable().optional()
});

export const deploymentVerifyServiceSchema = z.object({
  name: z.string(),
  status: z.string(),
  health: z.string().nullable(),
  restartCount: z.number().int(),
  /** Actual local image ID from `docker inspect .Image` (sha256:...). */
  imageId: z.string().nullable().optional(),
  /** Registry content-addressed identity when available (repo@sha256:...). */
  repoDigest: z.string().nullable().optional(),
  /** Image reference the container was created from. */
  imageRef: z.string().nullable().optional()
});

export const deploymentVerifyResponseSchema = z.object({
  verdict: z.enum(["CONVERGED_HEALTHY", "CONVERGED_DEGRADED", "PENDING", "DRIFTED", "FAILED"]),
  services: z.array(deploymentVerifyServiceSchema)
});

export const deploymentStateResponseSchema = z.object({
  exists: z.boolean(),
  currentRevisionNumber: z.number().int().positive().nullable()
});

export type StorageSummaryEntry = z.infer<typeof storageSummaryEntrySchema>;
export type NetworkInfo = z.infer<typeof networkInfoSchema>;
export type VolumeInfo = z.infer<typeof volumeInfoSchema>;
export type ComposeValidationResult = z.infer<typeof composeValidationResponseSchema>;
export type DeploymentVerifyResult = z.infer<typeof deploymentVerifyResponseSchema>;
export type DeploymentPullResult = z.infer<typeof deploymentPullResponseSchema>;

export type RuntimeContainer = z.infer<typeof containerRuntimeSchema>;
