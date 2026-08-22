"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Pause, Play, Loader2, WifiOff, WrapText } from "lucide-react";
import { maskSecrets } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Live container logs via Server-Sent Events (relayed through the control
 * plane — the browser never talks to the node agent directly).
 *
 * State-aware (Phase 6F.5 correction):
 *  - `nodeOnline === false` → "Logs unavailable — node is offline" (no stream,
 *    no reconnect loop).
 *  - `containerStatus` stopped/exited → historical logs only (single fetch via
 *    `historicalPath`), Live disabled, no SSE follow, no reconnect, banner
 *    "Container stopped — showing existing logs".
 *  - running/restarting/unknown → live tail + follow (existing behavior).
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
  /** Base path of the non-SSE historical logs endpoint, used when the container is stopped. */
  historicalPath?: string;
  downloadName: string;
  initialTail?: number;
  /** Runtime status of the container ("running" | "stopped" | "restarting" | "unhealthy" | "unknown"). */
  containerStatus?: string;
  /** Whether the hosting node is currently reachable. */
  nodeOnline?: boolean;
};

function isStopped(status?: string): boolean {
  return status === "stopped" || status === "exited";
}

export type ParsedLogLine = {
  raw: string;
  timestamp: string | null;
  time: string | null;
  message: string;
  level: "info" | "warn" | "error" | null;
};

/** Parse only an unambiguous ISO-like prefix; uncertain lines stay intact. */
export function parseLogLine(raw: string): ParsedLogLine {
  const timestampMatch = /^(?:\[)?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)(?:\])?(?:\s+|\s*[-|]\s*)/.exec(raw);
  let timestamp: string | null = null;
  let time: string | null = null;
  let message = raw;
  if (timestampMatch && !Number.isNaN(Date.parse(timestampMatch[1]))) {
    timestamp = timestampMatch[1];
    time = /[T ](\d{2}:\d{2}:\d{2})/.exec(timestamp)?.[1] ?? null;
    message = raw.slice(timestampMatch[0].length);
  }
  const levelMatch = /^(?:\[)?(INFO|WARN|WARNING|ERROR|ERR)(?:\])?(?=\s|:|-)/.exec(message);
  const level = levelMatch
    ? levelMatch[1] === "INFO" ? "info" : levelMatch[1].startsWith("WARN") ? "warn" : "error"
    : null;
  return { raw, timestamp, time, message, level };
}

function LogRows({ lines, wrap }: { lines: string[]; wrap: boolean }): React.JSX.Element {
  return (
    <>
      {lines.map((line, index) => {
        const parsed = parseLogLine(maskSecrets(line));
        return (
          <div
            key={`${index}-${line.length}`}
            className={cn(
              "group relative flex min-h-[21px] gap-3 px-3 pr-9 hover:bg-surface-raised",
              wrap ? "min-w-0" : "min-w-max whitespace-pre",
              parsed.level === "warn" && "bg-warning/[0.08]",
              parsed.level === "error" && "bg-critical/[0.09]"
            )}
          >
            {parsed.time && <span title={parsed.timestamp ?? undefined} className="w-[78px] shrink-0 select-none text-text-subtle">{parsed.time}</span>}
            <span className={cn(
              "min-w-0 flex-1",
              wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
              parsed.level === "info" && "text-success-foreground",
              parsed.level === "warn" && "text-warning-foreground",
              parsed.level === "error" && "text-critical-foreground",
              !parsed.level && "text-text"
            )}>{parsed.message}</span>
            <button
              type="button"
              aria-label={`Copy log line ${index + 1}`}
              onClick={() => { void navigator.clipboard.writeText(parsed.raw); }}
              className="absolute right-2 top-0.5 grid h-[18px] w-[18px] place-items-center rounded text-text-subtle opacity-0 hover:bg-surface-overlay hover:text-text group-hover:opacity-100 focus:opacity-100"
            >
              <Copy size={11} />
            </button>
          </div>
        );
      })}
    </>
  );
}

export function LogViewer({
  streamPath,
  historicalPath,
  downloadName,
  initialTail = 200,
  containerStatus,
  nodeOnline = true
}: LogViewerProps): React.JSX.Element {
  // Offline node: never start a stream or a reconnect loop.
  if (nodeOnline === false) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-panel border border-border bg-surface-deck">
        <div className="flex items-center gap-2 border-b border-border bg-surface-raised/55 px-3 py-2 text-sm text-muted">
          <WifiOff size={13} />
          Logs unavailable — node is offline
        </div>
        <div className="min-h-0 flex-1 bg-surface-hull/80 p-3 font-mono text-[11px] text-muted max-md:h-[420px]">
          No log data can be read while the node is unreachable.
        </div>
      </div>
    );
  }

  if (isStopped(containerStatus)) {
    return (
      <HistoricalLogViewer
        historicalPath={historicalPath ?? streamPath}
        downloadName={downloadName}
        initialTail={initialTail}
        banner="Container stopped — showing existing logs"
      />
    );
  }

  return (
    <LiveLogViewer
      streamPath={streamPath}
      downloadName={downloadName}
      initialTail={initialTail}
    />
  );
}

/** Single-shot historical logs for a stopped/exited container — no SSE, no reconnect. */
function HistoricalLogViewer({
  historicalPath,
  downloadName,
  initialTail,
  banner
}: {
  historicalPath: string;
  downloadName: string;
  initialTail: number;
  banner: string;
}): React.JSX.Element {
  const [tail, setTail] = useState(initialTail);
  const [filter, setFilter] = useState("");
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLines(null);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(`${historicalPath}?tail=${tail}`, {
          credentials: "include",
          cache: "no-store"
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as { logs?: string[] };
        if (!cancelled) setLines(payload.logs ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load logs");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [historicalPath, tail]);

  const filtered = useMemo(() => {
    if (!filter) return lines ?? [];
    const q = filter.toLowerCase();
    return (lines ?? []).filter((l) => l.toLowerCase().includes(q));
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-panel border border-border bg-surface-deck">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-raised/55 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-warning" />
          {banner}
        </span>
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
          <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)} className={cn("inline-flex h-8 items-center gap-1 rounded-control border px-2 font-mono text-[11px]", wrap ? "border-selected-border/40 bg-selected text-text" : "border-border bg-surface-hull/40 text-text-muted hover:text-text")}>
            <WrapText size={12} /> Wrap {wrap ? "on" : "off"}
          </button>
          <Button onClick={download} aria-label="Download logs" variant="outline" size="sm">
            <Download size={12} /> Download
          </Button>
        </div>
      </div>

      <pre className={cn("log-scroll min-h-0 flex-1 overflow-auto bg-surface-hull/80 py-2 font-mono text-[12.5px] leading-[21px] tabular-nums max-md:h-[420px] max-md:max-h-[420px]", wrap ? "overflow-x-hidden" : "overflow-x-auto")} data-log-wrap={wrap ? "on" : "off"}>
        {error !== null ? (
          <span className="text-muted">Failed to load logs: {error}</span>
        ) : lines === null ? (
          <span className="text-muted">Loading…</span>
        ) : filtered.length === 0 ? (
          <span className="text-muted">{filter ? "No log lines match." : "No logs available."}</span>
        ) : (
          <LogRows lines={filtered} wrap={wrap} />
        )}
      </pre>
      <div className="border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted">
        {lines === null ? "—" : `${lines.length} lines`}
      </div>
    </div>
  );
}

/** Live tail + follow (existing SSE behavior, unchanged). */
function LiveLogViewer({
  streamPath,
  downloadName,
  initialTail
}: {
  streamPath: string;
  downloadName: string;
  initialTail: number;
}): React.JSX.Element {
  const [tail, setTail] = useState(initialTail);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [lines, setLines] = useState<string[]>([]);
  const [wrap, setWrap] = useState(false);

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

  const handleScroll = (): void => {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-panel border border-border bg-surface-deck">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-raised/55 px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Resume live logs" : "Pause live logs"}
            className="inline-flex items-center gap-1 rounded-control border border-border bg-surface-hull/40 px-2 py-1 font-mono text-xs text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
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
          <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)} className={cn("inline-flex h-8 items-center gap-1 rounded-control border px-2 font-mono text-[11px]", wrap ? "border-selected-border/40 bg-selected text-text" : "border-border bg-surface-hull/40 text-text-muted hover:text-text")}>
            <WrapText size={12} /> Wrap {wrap ? "on" : "off"}
          </button>
          <Button onClick={download} aria-label="Download logs" variant="outline" size="sm">
            <Download size={12} /> Download
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
      <pre
        ref={preRef}
        onScroll={handleScroll}
        className={cn("log-scroll h-full min-h-0 overflow-y-auto bg-surface-hull/80 py-2 font-mono text-[12.5px] leading-[21px] tabular-nums max-md:h-[420px] max-md:max-h-[420px]", wrap ? "overflow-x-hidden" : "overflow-x-auto")}
        data-log-wrap={wrap ? "on" : "off"}
      >
        {filtered.length === 0 ? (
          <span className="text-muted">{filter ? "No log lines match." : "Waiting for logs…"}</span>
        ) : (
          <LogRows lines={filtered} wrap={wrap} />
        )}
      </pre>
      {!autoScroll && (
        <button
          type="button"
          onClick={() => {
            setAutoScroll(true);
            if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
          }}
          className="absolute bottom-3 right-4 rounded-full border border-selected-border/35 bg-surface-overlay px-3 py-1.5 font-mono text-[11px] text-brand shadow-overlay hover:text-brand-hover"
        >
          Jump to latest
        </button>
      )}
      </div>
    </div>
  );
}
