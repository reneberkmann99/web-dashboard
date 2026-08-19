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

export type StorageSummaryEntry = z.infer<typeof storageSummaryEntrySchema>;

export type RuntimeContainer = z.infer<typeof containerRuntimeSchema>;
