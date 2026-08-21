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
  health: z.enum(["healthy", "unhealthy", "starting"]).nullable().optional(),
  uptime: z.string().nullable(),
  ports: z.string(),
  createdAt: z.string().nullable(),
  cpuPercent: z.number().nullable(),
  memoryUsage: z.string().nullable(),
  restartCount: z.number().nullable(),
  restartPolicy: z.string().nullable().optional(),
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

/**
 * Permissive schema for the raw `docker inspect` document used by container
 * adoption. Docker's inspect shape is large and version-dependent; we validate
 * only the fields the adoption preflight needs and keep the rest as opaque
 * JSON so future compose fields can be synthesized without agent changes.
 */
export const containerInspectSchema = z.object({
  Id: z.string().optional(),
  Name: z.string().optional(),
  Created: z.string().optional(),
  State: z
    .object({
      Running: z.boolean().optional(),
      StartedAt: z.string().optional(),
      Status: z.string().optional()
    })
    .optional(),
  Config: z
    .object({
      Hostname: z.string().optional(),
      User: z.string().optional(),
      Env: z.array(z.string()).optional(),
      Cmd: z.array(z.string()).nullable().optional(),
      Image: z.string().optional(),
      WorkingDir: z.string().optional(),
      Entrypoint: z.array(z.string()).nullable().optional(),
      Labels: z.record(z.string(), z.string()).optional(),
      ExposedPorts: z.record(z.string(), z.unknown()).optional(),
      Healthcheck: z
        .object({
          Test: z.array(z.string()).nullable().optional(),
          Interval: z.number().optional(),
          Timeout: z.number().optional(),
          Retries: z.number().optional(),
          StartPeriod: z.number().optional()
        })
        .nullable()
        .optional()
    })
    .optional(),
  HostConfig: z
    .object({
      Binds: z.array(z.string()).nullable().optional(),
      PortBindings: z.record(z.string(), z.array(z.object({ HostIp: z.string().optional(), HostPort: z.string().optional() })).nullable()).optional(),
      RestartPolicy: z.object({ Name: z.string().optional(), MaximumRetryCount: z.number().optional() }).optional(),
      Memory: z.number().optional(),
      NanoCpus: z.number().optional(),
      CpuShares: z.number().optional(),
      Privileged: z.boolean().optional(),
      ReadonlyRootfs: z.boolean().optional(),
      CapAdd: z.array(z.string()).nullable().optional(),
      CapDrop: z.array(z.string()).nullable().optional(),
      Dns: z.array(z.string()).nullable().optional(),
      DnsSearch: z.array(z.string()).nullable().optional(),
      Devices: z.array(z.unknown()).nullable().optional(),
      Ulimits: z.array(z.unknown()).nullable().optional(),
      Sysctls: z.record(z.string(), z.string()).nullable().optional(),
      SecurityOpt: z.array(z.string()).nullable().optional(),
      NetworkMode: z.string().optional(),
      PidMode: z.string().optional(),
      IpcMode: z.string().optional(),
      ShmSize: z.number().optional(),
      LogConfig: z.object({ Type: z.string().optional(), Config: z.record(z.string(), z.string()).optional() }).nullable().optional(),
      Tmpfs: z.record(z.string(), z.string()).nullable().optional()
    })
    .optional(),
  Mounts: z
    .array(
      z.object({
        Type: z.string().optional(),
        Source: z.string().optional(),
        Destination: z.string().optional(),
        Mode: z.string().optional(),
        RW: z.boolean().optional(),
        Name: z.string().optional()
      })
    )
    .optional(),
  NetworkSettings: z
    .object({
      Networks: z
        .record(
          z.string(),
          z.object({
            Aliases: z.array(z.string()).nullable().optional(),
            IPAddress: z.string().optional(),
            Gateway: z.string().optional(),
            NetworkID: z.string().optional()
          })
        )
        .optional()
    })
    .optional()
});

export const containerInspectResponseSchema = z.object({
  nodeOnline: z.boolean(),
  inspect: containerInspectSchema.nullable().optional(),
  error: z.string().optional()
});

export const containerLabelsResponseSchema = z.object({
  nodeOnline: z.boolean(),
  success: z.boolean(),
  error: z.string().optional()
});

export const containerLogsResponseSchema = z.object({
  nodeOnline: z.boolean(),
  logs: z.array(z.string())
});

export const containerActionResponseSchema = z.object({
  nodeOnline: z.boolean(),
  success: z.boolean()
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
