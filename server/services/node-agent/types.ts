import { z } from "zod";

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
  lastUpdatedAt: z.string()
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

export type RuntimeContainer = z.infer<typeof containerRuntimeSchema>;
