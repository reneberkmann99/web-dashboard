import { Node, NodeStatus } from "@prisma/client";
import crypto from "node:crypto";
import { decryptSecret } from "@/server/security/crypto";
import { signRequest, sha256Hex } from "@/server/security/agent-signing";
import { secureFetch, SecureTransportError } from "@/server/services/node-agent/secure-transport";
import { z } from "zod";
import {
  containerDetailResponseSchema,
  containerInspectSchema,
  containerInspectResponseSchema,
  containerLabelsResponseSchema,
  containerLogsResponseSchema,
  containerActionResponseSchema,
  listContainersResponseSchema,
  storageSummaryResponseSchema,
  networksInspectResponseSchema,
  volumesInspectResponseSchema,
  composeValidationResponseSchema,
  deploymentPreparedResponseSchema,
  deploymentPullResponseSchema,
  deploymentApplyResponseSchema,
  deploymentVerifyResponseSchema,
  deploymentStateResponseSchema,
  RuntimeContainer,
  StorageSummaryEntry,
  NetworkInfo,
  VolumeInfo,
  DeploymentVerifyResult,
  DeploymentPullResult
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
    method = "GET",
    body?: unknown
  ): Promise<AgentResponse<T>> {
    if (!node.isActive || node.status === NodeStatus.INACTIVE) {
      return { ok: false, data: null };
    }

    // Transport preference: a TLS_VERIFIED node serves ALL ordinary traffic
    // over verified HTTPS. If that fails we fall back to legacy HTTP ONLY for
    // these non-secret read/inventory calls (documented migration behavior);
    // managed-deployment mutations never take this path — they use
    // `callSigned` -> `secureFetch`, which has no fallback.
    if (node.transportMode === "TLS_VERIFIED" && node.tlsApiBaseUrl) {
      try {
        const result = await secureFetch(node, {
          method,
          path,
          headers: {
            "Content-Type": "application/json",
            "x-agent-key": decryptSecret(node.apiKeyEncrypted)
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          timeoutMs: this.timeoutMs
        });
        if (result.status < 200 || result.status >= 300) {
          return { ok: false, data: null };
        }
        return { ok: true, data: JSON.parse(result.body) as T };
      } catch (error) {
        console.error(
          `[NodeAgent] secure ${method} ${path} on node ${node.id} failed:`,
          error instanceof SecureTransportError ? error.code : "transport error"
        );
        // fall through to legacy HTTP for non-secret operational calls
      }
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
        body: body !== undefined ? JSON.stringify(body) : undefined,
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

  /** Full `docker inspect` document (adoption preflight). Null when unavailable. */
  async inspectContainerFull(
    node: Node,
    containerId: string
  ): Promise<{ nodeOnline: boolean; inspect: z.infer<typeof containerInspectSchema> | null }> {
    const result = await this.call<unknown>(node, `/containers/${encodeURIComponent(containerId)}/inspect`);
    if (!result.ok || !result.data) {
      return { nodeOnline: false, inspect: null };
    }
    const parsed = containerInspectResponseSchema.safeParse(result.data);
    if (!parsed.success || !parsed.data.inspect) {
      return { nodeOnline: false, inspect: null };
    }
    return { nodeOnline: parsed.data.nodeOnline, inspect: parsed.data.inspect };
  }

  /** Add compose labels to a live container without restarting it (adoption). */
  async labelContainer(node: Node, containerId: string, labels: Record<string, string>): Promise<boolean> {
    const result = await this.call<unknown>(node, `/containers/${encodeURIComponent(containerId)}/labels`, "POST", {
      labels
    });
    if (!result.ok || !result.data) return false;
    const parsed = containerLabelsResponseSchema.safeParse(result.data);
    return parsed.success && parsed.data.success === true;
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
    if (!result.ok || !result.data) return false;
    const parsed = containerActionResponseSchema.safeParse(result.data);
    return parsed.success && parsed.data.nodeOnline && parsed.data.success;
  }

  /** Remove a container (`docker rm -f`, volumes preserved). */
  async removeContainer(node: Node, containerId: string): Promise<boolean> {
    const result = await this.call<unknown>(
      node,
      `/containers/${encodeURIComponent(containerId)}`,
      "DELETE"
    );
    if (!result.ok || !result.data) return false;
    const parsed = containerActionResponseSchema.safeParse(result.data);
    return parsed.success && parsed.data.nodeOnline && parsed.data.success;
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

  /** Batch network inspection, bounded by the caller (agent caps at 50). */
  async inspectNetworks(node: Node, names: string[]): Promise<NetworkInfo[]> {
    if (names.length === 0) return [];
    const result = await this.call<unknown>(node, "/networks/inspect", "POST", { names });
    if (!result.ok || !result.data) {
      return [];
    }
    const parsed = networksInspectResponseSchema.safeParse(result.data);
    return parsed.success ? parsed.data.networks : [];
  }

  /** Batch named-volume inspection, bounded by the caller (agent caps at 50). */
  async inspectVolumes(node: Node, names: string[]): Promise<VolumeInfo[]> {
    if (names.length === 0) return [];
    const result = await this.call<unknown>(node, "/volumes/inspect", "POST", { names });
    if (!result.ok || !result.data) {
      return [];
    }
    const parsed = volumesInspectResponseSchema.safeParse(result.data);
    return parsed.success ? parsed.data.volumes : [];
  }

  /**
   * Read-only Compose validation (Phase 6A). Sends compose source + an env map
   * (non-secret values + deterministic secret SENTINELS — never real secrets)
   * to the agent, which runs `docker compose config` only. No mutating
   * subcommand is ever invoked.
   */
  async validateCompose(
    node: Node,
    input: { compose: string; env: Record<string, string> }
  ): Promise<{
    composeSupported: boolean;
    composeVersion: string | null;
    valid: boolean;
    errors: string[];
    normalized: string | null;
  }> {
    const result = await this.call<unknown>(node, "/compose/validate", "POST", {
      compose: input.compose,
      env: input.env
    });
    if (!result.ok || !result.data) {
      return {
        composeSupported: false,
        composeVersion: null,
        valid: false,
        errors: ["Node agent is unreachable"],
        normalized: null
      };
    }
    const parsed = composeValidationResponseSchema.safeParse(result.data);
    if (!parsed.success) {
      return {
        composeSupported: false,
        composeVersion: null,
        valid: false,
        errors: ["Unexpected agent response"],
        normalized: null
      };
    }
    return parsed.data;
  }

  /**
   * Signed mutation request over VERIFIED HTTPS (Phase 6B.1). Used ONLY for
   * managed deployment mutation endpoints (prepare/pull/apply/verify/abort).
   *
   * Defense in depth, in this order:
   *   TLS (CA chain + logical node identity SAN + active-certificate pinning)
   *   + HMAC signature (control-plane identity + body integrity)
   *   + nonce/timestamp replay protection + operation id.
   *
   * There is NO HTTP fallback: `secureFetch` throws before any network I/O if
   * the destination is not HTTPS, so a secret-bearing body can never be written
   * to a plaintext socket.
   */
  private async callSigned<T>(
    node: Node,
    path: string,
    method: string,
    body: unknown,
    operationId: string,
    timeoutMs?: number
  ): Promise<AgentResponse<T>> {
    if (!node.isActive || node.status === NodeStatus.INACTIVE) {
      return { ok: false, data: null };
    }

    const key = decryptSecret(node.apiKeyEncrypted);
    const bodyText = body !== undefined ? JSON.stringify(body) : "";
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const signature = signRequest(key, {
      method,
      path,
      timestamp,
      nonce,
      bodySha256: sha256Hex(bodyText),
      operationId
    });

    try {
      const result = await secureFetch(node, {
        method,
        path,
        headers: {
          "Content-Type": "application/json",
          "x-agent-key": key,
          "x-agent-signature": signature,
          "x-agent-timestamp": String(timestamp),
          "x-agent-nonce": nonce,
          "x-agent-operation-id": operationId
        },
        body: body !== undefined ? bodyText : undefined,
        timeoutMs
      });
      if (result.status < 200 || result.status >= 300) {
        return { ok: false, data: null };
      }
      return { ok: true, data: JSON.parse(result.body) as T };
    } catch (error) {
      // Fails closed — never retried over plaintext HTTP.
      console.error(
        `[NodeAgent] secure ${method} ${path} on node ${node.id} failed:`,
        error instanceof SecureTransportError ? error.code : "transport error"
      );
      return { ok: false, data: null };
    }
  }

  async prepareDeployment(
    node: Node,
    input: { deploymentId: string; operationId: string; revisionNumber: number; compose: string; env: Record<string, string>; composeProjectName: string }
  ): Promise<{ ok: boolean; prepared: boolean; revisionNumber: number; error?: string }> {
    const result = await this.callSigned<unknown>(
      node,
      `/deployments/${encodeURIComponent(input.deploymentId)}/prepare`,
      "POST",
      input,
      input.operationId
    );
    if (!result.ok || !result.data) {
      return { ok: false, prepared: false, revisionNumber: input.revisionNumber, error: "Agent unreachable" };
    }
    const parsed = deploymentPreparedResponseSchema.safeParse(result.data);
    if (!parsed.success) {
      return { ok: false, prepared: false, revisionNumber: input.revisionNumber, error: "Unexpected agent response" };
    }
    return parsed.data.ok
      ? { ok: true, prepared: parsed.data.prepared, revisionNumber: parsed.data.revisionNumber }
      : { ok: false, prepared: false, revisionNumber: input.revisionNumber, error: parsed.data.error ?? "prepare failed" };
  }

  async pullDeployment(
    node: Node,
    input: { deploymentId: string; operationId: string; revisionNumber: number }
  ): Promise<{ ok: boolean; images: DeploymentPullResult["images"]; error?: string }> {
    const result = await this.callSigned<unknown>(
      node,
      `/deployments/${encodeURIComponent(input.deploymentId)}/pull`,
      "POST",
      input,
      input.operationId,
      300_000 // image pulls can be slow on first deploy
    );
    if (!result.ok || !result.data) {
      return { ok: false, images: [], error: "Agent unreachable" };
    }
    const parsed = deploymentPullResponseSchema.safeParse(result.data);
    if (!parsed.success) return { ok: false, images: [], error: "Unexpected agent response" };
    return parsed.data.ok
      ? { ok: true, images: parsed.data.images }
      : { ok: false, images: [], error: parsed.data.error ?? "pull failed" };
  }

  async applyDeployment(
    node: Node,
    input: { deploymentId: string; operationId: string; revisionNumber: number; secrets: Record<string, string> }
  ): Promise<{ ok: boolean; applied: boolean; error?: string }> {
    const result = await this.callSigned<unknown>(
      node,
      `/deployments/${encodeURIComponent(input.deploymentId)}/apply`,
      "POST",
      input,
      input.operationId,
      120_000 // `docker compose up -d` may recreate containers; give it headroom
    );
    if (!result.ok || !result.data) {
      return { ok: false, applied: false, error: "Agent unreachable" };
    }
    const parsed = deploymentApplyResponseSchema.safeParse(result.data);
    if (!parsed.success) return { ok: false, applied: false, error: "Unexpected agent response" };
    return parsed.data.ok
      ? { ok: true, applied: parsed.data.applied }
      : { ok: false, applied: false, error: parsed.data.error ?? "apply failed" };
  }

  async verifyDeployment(
    node: Node,
    input: { deploymentId: string; operationId: string; revisionNumber: number }
  ): Promise<DeploymentVerifyResult | null> {
    const result = await this.callSigned<unknown>(
      node,
      `/deployments/${encodeURIComponent(input.deploymentId)}/verify`,
      "POST",
      input,
      input.operationId
    );
    if (!result.ok || !result.data) return null;
    const parsed = deploymentVerifyResponseSchema.safeParse(result.data);
    return parsed.success ? parsed.data : null;
  }

  async abortDeployment(node: Node, input: { deploymentId: string; operationId: string }): Promise<boolean> {
    const result = await this.callSigned<unknown>(
      node,
      `/deployments/${encodeURIComponent(input.deploymentId)}/abort`,
      "POST",
      input,
      input.operationId
    );
    return result.ok;
  }

  async getDeploymentState(
    node: Node,
    input: { deploymentId: string }
  ): Promise<{ exists: boolean; currentRevisionNumber: number | null } | null> {
    const result = await this.call<unknown>(node, `/deployments/${encodeURIComponent(input.deploymentId)}/state`);
    if (!result.ok || !result.data) return null;
    const parsed = deploymentStateResponseSchema.safeParse(result.data);
    return parsed.success ? parsed.data : null;
  }

  /** Agent + host metadata (version, docker version, os, cpu, memory, disk, compose). */
  async getNodeInfo(node: Node): Promise<{
    agentVersion?: string;
    dockerVersion?: string;
    composeSupported?: boolean;
    composeVersion?: string | null;
    managedDeploymentValidationSupported?: boolean;
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
      composeSupported: typeof data.composeSupported === "boolean" ? data.composeSupported : undefined,
      composeVersion: typeof data.composeVersion === "string" ? data.composeVersion : null,
      managedDeploymentValidationSupported:
        typeof data.managedDeploymentValidationSupported === "boolean"
          ? data.managedDeploymentValidationSupported
          : undefined,
      osInfo:
        data.os && typeof data.os === "string"
          ? { os: data.os, arch: data.arch ?? null }
          : undefined,
      systemInfo:
        data.hostname || data.cpuCount || data.totalMemBytes
          ? {
              hostname: data.hostname ?? null,
              cpuCount: data.cpuCount ?? null,
              totalMemBytes: data.totalMemBytes ?? null,
              // Point-in-time snapshot from the agent's most recent /info call —
              // sustained pressure is derived server-side from NodeResourceSample
              // history (see server/services/attention.ts), not from this alone.
              cpuPercent: typeof data.cpuPercent === "number" ? data.cpuPercent : null,
              memPercent: typeof data.memPercent === "number" ? data.memPercent : null,
              diskPercent: typeof data.diskPercent === "number" ? data.diskPercent : null,
              diskTotalBytes: typeof data.diskTotalBytes === "number" ? data.diskTotalBytes : null,
              diskFreeBytes: typeof data.diskFreeBytes === "number" ? data.diskFreeBytes : null
            }
          : undefined
    };
  }
}

export const nodeAgentClient = new NodeAgentClient();
