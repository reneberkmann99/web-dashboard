import type { Node } from "@prisma/client";
import { nodeAgentClient } from "@/server/services/node-agent/client";

/**
 * Server-Sent Events relay for container logs.
 *
 * Flow: browser → control plane (SSE) → node agent (raw `docker logs --follow`)
 *
 * The browser never talks to the agent directly; authorization is enforced by
 * the route handler *before* this stream is created. This module only turns an
 * authorized agent stream into SSE frames and guarantees the underlying agent
 * connection is torn down when the browser disconnects.
 */

const encoder = new TextEncoder();

function sse(data: string): Uint8Array {
  return encoder.encode(`data: ${data}\n\n`);
}

/**
 * Build an SSE ReadableStream that relays the agent's raw log stream.
 * Emits one `data:` event per line. On agent failure the stream is closed
 * gracefully (the browser sees the connection end and can reconnect).
 */
export function agentLogsToSSE(node: Node, dockerContainerId: string, tail: number): ReadableStream<Uint8Array> {
  let agentStream: ReadableStream<Uint8Array> | null = null;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      agentStream = await nodeAgentClient.streamLogs(node, dockerContainerId, tail);

      if (!agentStream) {
        controller.enqueue(sse("__hostpanel_error__:node unreachable"));
        controller.close();
        return;
      }

      const reader = agentStream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      void (async () => {
        try {
          while (!cancelled) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, idx).replace(/\r$/, "");
              buffer = buffer.slice(idx + 1);
              if (line.length > 0) {
                controller.enqueue(sse(line));
              }
            }
          }
          if (buffer.length > 0) {
            controller.enqueue(sse(buffer.replace(/\r$/, "")));
          }
          controller.close();
        } catch (error) {
          // Stream interrupted (node disconnect, container removed, etc.).
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      })();
    },
    cancel() {
      cancelled = true;
      if (agentStream) {
        agentStream.cancel().catch(() => undefined);
      }
    }
  });
}
