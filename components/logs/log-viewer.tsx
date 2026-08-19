"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, Loader2, WifiOff } from "lucide-react";
import { maskSecrets } from "@/lib/format";

/**
 * Live container logs via Server-Sent Events (relayed through the control
 * plane — the browser never talks to the node agent directly).
 *
 * Features: initial tail + live follow, pause/resume (buffered), client-side
 * filter, auto-scroll only while already at the bottom, connection status,
 * bounded line buffer, and download of the current view.
 */

const MAX_LINES = 5000;
const MAX_PAUSE_BUFFER = 2000;

type LogViewerProps = {
  /** Returns the SSE endpoint for a given tail size. */
  streamUrl: (tail: number) => string;
  downloadName: string;
  initialTail?: number;
};

export function LogViewer({ streamUrl, downloadName, initialTail = 200 }: LogViewerProps): React.JSX.Element {
  const [tail, setTail] = useState(initialTail);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [lines, setLines] = useState<string[]>([]);

  const pausedRef = useRef(paused);
  const bufferRef = useRef<string[]>([]);
  const preRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && bufferRef.current.length > 0) {
      const buffered = bufferRef.current;
      bufferRef.current = [];
      setLines((prev) => prev.concat(buffered).slice(-MAX_LINES));
    }
  }, [paused]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const appendLine = useCallback((line: string) => {
    if (!mountedRef.current) return;
    if (pausedRef.current) {
      bufferRef.current.push(line);
      if (bufferRef.current.length > MAX_PAUSE_BUFFER) {
        bufferRef.current = bufferRef.current.slice(-MAX_PAUSE_BUFFER);
      }
      return;
    }
    setLines((prev) => prev.concat(line).slice(-MAX_LINES));
  }, []);

  // Establish the SSE connection. Re-runs when tail changes; the connection is
  // torn down on unmount or tail change. When it drops and the component is
  // still mounted and not paused, it reconnects after a short delay.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (cancelled || !mountedRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setConnected(false);

      void (async () => {
        try {
          const response = await fetch(streamUrl(tail), {
            signal: controller.signal,
            credentials: "include",
            cache: "no-store"
          });
          if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
          }
          setConnected(true);

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n")) >= 0) {
              let chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 1);
              chunk = chunk.replace(/\r$/, "");
              if (chunk.startsWith("data: ")) {
                appendLine(chunk.slice(6));
              }
            }
          }
          setConnected(false);
        } catch {
          setConnected(false);
        } finally {
          if (!cancelled && mountedRef.current && !pausedRef.current) {
            retryTimer = setTimeout(connect, 2000);
          }
        }
      })();
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      abortRef.current?.abort();
    };
  }, [tail, streamUrl, appendLine]);

  // Auto-scroll: only pin to the bottom while the user is already at/near the
  // bottom and autoScroll is on.
  const handleScroll = (): void => {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom) {
      setAutoScroll(false);
    } else {
      setAutoScroll(true);
    }
  };

  useEffect(() => {
    if (autoScroll && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const filtered = useMemo(() => {
    if (!filter) return lines;
    const q = filter.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(q));
  }, [lines, filter]);

  const download = (): void => {
    const blob = new Blob([filtered.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${downloadName}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Resume live logs" : "Pause live logs"}
            className="inline-flex items-center gap-1 rounded border border-border bg-panelAlt px-2 py-1 text-xs hover:text-text focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
            {paused ? "Resume" : "Pause"}
          </button>
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            {connected ? (
              <>
                <span className="h-2 w-2 rounded-full bg-success" /> Live
              </>
            ) : (
              <>
                <WifiOff size={12} /> {paused ? "Paused" : "Disconnected"}
              </>
            )}
          </span>
          {!connected && !paused && <Loader2 size={12} className="animate-spin text-muted" />}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter logs…"
            aria-label="Filter logs"
            className="w-36 rounded-md border border-border bg-panelAlt px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-accent"
          />
          <select
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
            aria-label="Number of log lines"
            className="rounded-md border border-border bg-panelAlt px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-accent"
          >
            {[100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n} lines
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={download}
            aria-label="Download logs"
            className="inline-flex items-center gap-1 rounded border border-border bg-panelAlt px-2 py-1 text-xs hover:text-text focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <Download size={12} /> Download
          </button>
        </div>
      </div>

      <pre
        ref={preRef}
        onScroll={handleScroll}
        className="h-[560px] max-h-[560px] overflow-auto rounded-lg border border-border bg-black/40 p-3 text-xs leading-relaxed text-slate-200"
      >
        {filtered.length === 0 ? (
          <span className="text-muted">{filter ? "No log lines match." : "Waiting for logs…"}</span>
        ) : (
          filtered.map((line, i) => <div key={`${i}-${line.length}`}>{maskSecrets(line)}</div>)
        )}
      </pre>
      {!autoScroll && (
        <button
          type="button"
          onClick={() => {
            setAutoScroll(true);
            if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
          }}
          className="text-xs text-accent hover:underline"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
