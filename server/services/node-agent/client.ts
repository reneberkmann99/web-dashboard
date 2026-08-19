import { Node, NodeStatus } from "@prisma/client";
import { decryptSecret } from "@/server/security/crypto";
import {
  containerDetailResponseSchema,
  containerLogsResponseSchema,
  listContainersResponseSchema,
  storageSummaryResponseSchema,
  RuntimeContainer,
  StorageSummaryEntry
} from "@/server/services/node-agent/types";

/**
 * Security: server-to-server agent client.
 * - All container IDs are URL-encoded before use in agent URLs.
 * - API keys are decrypted on each call (never cached in memory).
 * - Agent responses are validated with Zod before returning to callers.
 * - Timeouts prevent hanging requests from blocking the web app.
 * - Errors are normalized: agent internals are never surfaced to the browser.
 */

type AgentResponse<T> = {
  ok: boolean;
  data: T | null;
};

export class NodeAgentClient {
  private readonly timeoutMs: number;

  constructor() {
    this.timeoutMs = Number(process.env.NODE_AGENT_TIMEOUT_MS ?? 5000);
  }

  private async call<T>(
    node: Node,
    path: string,
    method = "GET"
  ): Promise<AgentResponse<T>> {
    if (!node.isActive || node.status === NodeStatus.INACTIVE) {
      return { ok: false, data: null };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = new URL(path, node.apiBaseUrl);
      const response = await fetch(url.toString(), {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-agent-key": decryptSecret(node.apiKeyEncrypted)
        },
        signal: controller.signal,
        cache: "no-store"
      });

      if (!response.ok) {
        console.error(`[NodeAgent] ${method} ${path} on node ${node.id} returned ${response.status}`);
        return { ok: false, data: null };
      }

      return { ok: true, data: (await response.json()) as T };
    } catch (error) {
      // Distinguish timeout from other errors for operational diagnosis
      if (error instanceof DOMException && error.name === "AbortError") {
        console.error(`[NodeAgent] timeout after ${this.timeoutMs}ms: ${method} ${path} on node ${node.id}`);
      } else {
        console.error(`[NodeAgent] ${method} ${path} on node ${node.id} failed:`, error instanceof Error ? error.message : error);
      }
      return { ok: false, data: null };
    } finally {
      clearTimeout(timeout);
    }
  }

  async listContainers(node: Node): Promise<{ nodeOnline: boolean; containers: RuntimeContainer[] }> {
    const result = await this.call<unknown>(node, "/containers");
    if (!result.ok || !result.data) {
      return { nodeOnline: false, containers: [] };
    }

    const parsed = listContainersResponseSchema.safeParse(result.data);
    if (!parsed.success) {
      return { nodeOnline: false, containers: [] };
    }

    return parsed.data;
  }

  async getContainer(
    node: Node,
    containerId: string
  ): Promise<{ nodeOnline: boolean; container: RuntimeContainer | null; metadata?: Record<string, unknown> }> {
    const result = await this.call<unknown>(node, `/containers/${encodeURIComponent(containerId)}`);
    if (!result.ok || !result.data) {
      return { nodeOnline: false, container: null };
    }

    const parsed = containerDetailResponseSchema.safeParse(result.data);
    if (!parsed.success) {
      return { nodeOnline: false, container: null };
    }

    return parsed.data;
  }

  async getLogs(node: Node, containerId: string, tail = 200): Promise<{ nodeOnline: boolean; logs: string[] }> {
    const result = await this.call<unknown>(
      node,
      `/containers/${encodeURIComponent(containerId)}/logs?tail=${tail}`
    );

    if (!result.ok || !result.data) {
      return { nodeOnline: false, logs: [] };
    }

    const parsed = containerLogsResponseSchema.safeParse(result.data);
    if (!parsed.success) {
      return { nodeOnline: false, logs: [] };
    }

    return parsed.data;
  }

  /**
   * Open a streaming (tail + follow) log connection to the node agent.
   * Returns the raw response body, or null when the node is unreachable/
   * disabled. The caller is responsible for reading and closing the stream.
   * No timeout is applied here — a live log stream is intentionally long-lived.
   */
  async streamLogs(
    node: Node,
    containerId: string,
    tail = 200
  ): Promise<ReadableStream<Uint8Array> | null> {
    if (!node.isActive || node.status === NodeStatus.INACTIVE) {
      return null;
    }
    try {
      const url = new URL(
        `/containers/${encodeURIComponent(containerId)}/logs/stream?tail=${tail}`,
        node.apiBaseUrl
      );
      const response = await fetch(url.toString(), {
        headers: { "x-agent-key": decryptSecret(node.apiKeyEncrypted) },
        cache: "no-store"
      });
      if (!response.ok || !response.body) {
        console.error(`[NodeAgent] logs/stream on node ${node.id} returned ${response.status}`);
        return null;
      }
      return response.body;
    } catch (error) {
      console.error(
        `[NodeAgent] stream /containers/:id/logs/stream on node ${node.id} failed:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  async runAction(node: Node, containerId: string, action: "start" | "stop" | "restart"): Promise<boolean> {
    const result = await this.call<unknown>(
      node,
      `/containers/${encodeURIComponent(containerId)}/${action}`,
      "POST"
    );
    return result.ok;
  }

  async checkHealth(node: Node): Promise<boolean> {
    const result = await this.call<unknown>(node, "/health");
    return result.ok;
  }

  /** Docker storage summary (images/containers/volumes/build-cache). */
  async getStorageSummary(node: Node): Promise<StorageSummaryEntry[]> {
    const result = await this.call<unknown>(node, "/storage");
    if (!result.ok || !result.data) {
      return [];
    }
    const parsed = storageSummaryResponseSchema.safeParse(result.data);
    if (!parsed.success) {
      return [];
    }
    return parsed.data.summary;
  }

  /** Agent + host metadata (version, docker version, os, cpu, memory). */
  async getNodeInfo(node: Node): Promise<{
    agentVersion?: string;
    dockerVersion?: string;
    osInfo?: Record<string, unknown>;
    systemInfo?: Record<string, unknown>;
  }> {
    const result = await this.call<unknown>(node, "/info");
    if (!result.ok || !result.data || typeof result.data !== "object") {
      return {};
    }
    const data = result.data as Record<string, unknown>;
    return {
      agentVersion: typeof data.agentVersion === "string" ? data.agentVersion : undefined,
      dockerVersion: typeof data.dockerVersion === "string" ? data.dockerVersion : undefined,
      osInfo:
        data.os && typeof data.os === "string"
          ? { os: data.os, arch: data.arch ?? null }
          : undefined,
      systemInfo:
        data.hostname || data.cpuCount || data.totalMemBytes
          ? {
              hostname: data.hostname ?? null,
              cpuCount: data.cpuCount ?? null,
              totalMemBytes: data.totalMemBytes ?? null
            }
          : undefined
    };
  }
}

export const nodeAgentClient = new NodeAgentClient();
