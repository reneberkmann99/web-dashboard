"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, Loader2, WifiOff } from "lucide-react";
import { maskSecrets } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

/**
 * Live container logs via Server-Sent Events (relayed through the control
 * plane — the browser never talks to the node agent directly).
 *
 * Features: initial tail + live follow, pause/resume (buffered), client-side
 * filter, auto-scroll only while already at the bottom, connection status,
 * bounded line buffer, and download of the current view.
 *
 * Duplication guard: the server re-sends the full tail whenever a new SSE
 * connection is established (initial load, tail change, or reconnect after a
 * drop). The component therefore REPLACES the current lines when a fresh
 * connection delivers its first data, instead of appending — so reconnects
 * never double the buffer. `streamPath` must be a stable string (never an
 * inline function), otherwise the effect re-runs on every parent render and
 * reconnects in a loop.
 */

const MAX_LINES = 5000;
const MAX_PAUSE_BUFFER = 2000;

type LogViewerProps = {
  /** Base path of the SSE stream (no query string); `?tail=` is appended internally. Must be render-stable. */
  streamPath: string;
  downloadName: string;
  initialTail?: number;
};

export function LogViewer({ streamPath, downloadName, initialTail = 200 }: LogViewerProps): React.JSX.Element {
  const [tail, setTail] = useState(initialTail);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [lines, setLines] = useState<string[]>([]);

  const pausedRef = useRef(paused);
  const connectedRef = useRef(false);
  const bufferRef = useRef<string[]>([]);
  const preRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => {});

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

  // Pause/resume: flush the buffer on resume, and re-establish the stream if
  // it dropped while paused (otherwise the view would stay stale forever).
  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) {
      if (bufferRef.current.length > 0) {
        const buffered = bufferRef.current;
        bufferRef.current = [];
        setLines((prev) => prev.concat(buffered).slice(-MAX_LINES));
      }
      if (!connectedRef.current) connectRef.current();
    }
  }, [paused]);

  // Establish the SSE connection. Re-runs only when tail or streamPath change.
  // On (re)connect the server re-sends the tail, so the first successful
  // delivery replaces the line buffer rather than appending to it.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (cancelled || !mountedRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setConnected(false);
      connectedRef.current = false;

      void (async () => {
        try {
          const response = await fetch(`${streamPath}?tail=${tail}`, {
            signal: controller.signal,
            credentials: "include",
            cache: "no-store"
          });
          if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
          }
          setConnected(true);
          connectedRef.current = true;
          // Fresh connection → the incoming tail is the new baseline.
          setLines([]);

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
          connectedRef.current = false;
        } catch {
          setConnected(false);
          connectedRef.current = false;
        } finally {
          if (!cancelled && mountedRef.current && !pausedRef.current) {
            retryTimer = setTimeout(connect, 2000);
          }
        }
      })();
    };

    connectRef.current = connect;
    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      abortRef.current?.abort();
    };
  }, [tail, streamPath, appendLine]);

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
    <div className="overflow-hidden rounded-panel border border-border bg-surface-deck">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-raised/55 px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Resume live logs" : "Pause live logs"}
            className="inline-flex items-center gap-1 rounded-control border border-border bg-surface-hull/40 px-2 py-1 font-mono text-xs text-text-muted hover:text-text focus:outline-none focus:ring-2 focus:ring-focus"
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
            {paused ? "Resume" : "Pause"}
          </button>
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            {connected ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-info" /> Live
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
          <Input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter logs…"
            aria-label="Filter logs"
            className="h-control-sm w-36 px-2 py-1 font-mono text-xs"
          />
          <Select
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
            aria-label="Number of log lines"
            className="h-control-sm w-auto px-2 py-1 font-mono text-xs"
          >
            {[100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n} lines
              </option>
            ))}
          </Select>
          <Button
            onClick={download}
            aria-label="Download logs"
            variant="outline"
            size="sm"
          >
            <Download size={12} /> Download
          </Button>
        </div>
      </div>

      <pre
        ref={preRef}
        onScroll={handleScroll}
        className="log-scroll h-[420px] max-h-[420px] overflow-auto bg-surface-hull/80 p-3 font-mono text-[11px] leading-relaxed text-text"
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
          className="border-t border-border px-3 py-2 font-mono text-xs text-brand hover:text-brand-hover"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
