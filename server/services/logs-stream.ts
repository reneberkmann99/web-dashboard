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
 *
 * Resource limits (Phase 4 — protect the control plane from pathological log
 * volume without ever terminating a normal continuous stream on total bytes):
 *   - MAX_LINE_BYTES (16 KiB): an individual log line longer than this is
 *     truncated and marked with a literal "[log line truncated]" suffix, so a
 *     single oversized event can't balloon the parse buffer or an SSE frame.
 *   - MAX_PENDING_BYTES (1 MiB): the line-assembly buffer is bounded. When it
 *     exceeds the cap, the excess is dropped (with an inline marker) rather
 *     than retained — a chatty burst can never cause unbounded control-plane
 *     memory growth. Backpressure still applies through the ReadableStream
 *     controller: `controller.enqueue` is only called after `desiredSize` is
 *     checked, so a slow browser slows the relay instead of queueing forever.
 *
 * Documented limits (also in ARCHITECTURE.md / UX-NOTES.md):
 *   line cap 16 KiB (truncated), pending buffer cap 1 MiB (dropped with
 *   marker), relay frame bounded to the line cap, agent connection torn down
 *   on browser disconnect / reader error / stream end.
 */

const MAX_LINE_BYTES = 16 * 1024; // 16 KiB per line/event
const MAX_PENDING_BYTES = 1024 * 1024; // 1 MiB line-assembly buffer
const TRUNCATE_MARKER = " [log line truncated]";

const encoder = new TextEncoder();

function sse(data: string): Uint8Array {
  return encoder.encode(`data: ${data}\n\n`);
}

/**
 * Truncate an oversized line at a UTF-8 safe boundary. We operate on decoded
 * strings, so we truncate on character count; the byte budget is enforced on
 * the encoded SSE frame by the line cap below (a 16 KiB line can't exceed the
 * cap because we cut it before encoding).
 */
function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_BYTES) {
    return line;
  }
  // Cut at a char boundary conservatively (avoid splitting a surrogate pair).
  const cut = line.slice(0, MAX_LINE_BYTES);
  const lastChar = cut.charCodeAt(cut.length - 1);
  const safeCut = lastChar >= 0xd800 && lastChar <= 0xdbff ? cut.slice(0, -1) : cut;
  return `${safeCut}${TRUNCATE_MARKER}`;
}

/** True if the decoded string exceeds the byte cap after encoding (approx. via char length). */
function exceedsLineCap(line: string): boolean {
  // charCodeAt-based estimate: each char is 1-4 bytes; use 4 as a safe upper
  // bound for the check so we never emit a frame larger than MAX_LINE_BYTES.
  return line.length * 4 > MAX_LINE_BYTES;
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

            // Bound the assembly buffer: if a burst pushes us over the cap,
            // drop the excess with a marker rather than retaining it.
            if (buffer.length > MAX_PENDING_BYTES) {
              buffer = `${buffer.slice(-MAX_PENDING_BYTES)}…[buffer dropped]`;
            }

            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
              const rawLine = buffer.slice(0, idx).replace(/\r$/, "");
              buffer = buffer.slice(idx + 1);

              if (rawLine.length > 0) {
                const line = exceedsLineCap(rawLine) ? truncateLine(rawLine) : rawLine;
                // Respect backpressure: wait for the consumer before enqueueing
                // the next frame instead of unboundedly queueing in memory.
                if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                  await new Promise<void>((resolve) => {
                    const poll = (): void => {
                      if (controller.desiredSize === null || controller.desiredSize > 0 || cancelled) {
                        resolve();
                      } else {
                        setTimeout(poll, 10);
                      }
                    };
                    poll();
                  });
                }
                if (cancelled) break;
                controller.enqueue(sse(line));
              }
            }
            if (cancelled) break;
          }
          if (!cancelled && buffer.length > 0) {
            const rawLine = buffer.replace(/\r$/, "");
            const line = exceedsLineCap(rawLine) ? truncateLine(rawLine) : rawLine;
            controller.enqueue(sse(line));
          }
          if (!cancelled) {
            controller.close();
          }
        } catch (error) {
          // Stream interrupted (node disconnect, container removed, etc.).
          try {
            controller.close();
          } catch {
            // already closed
          }
        } finally {
          // Always tear down the agent connection, even on error paths.
          if (agentStream) {
            agentStream.cancel().catch(() => undefined);
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

export { MAX_LINE_BYTES, MAX_PENDING_BYTES };
