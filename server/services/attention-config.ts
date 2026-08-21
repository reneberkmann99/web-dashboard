/**
 * Centralized attention-model thresholds (Phase 6D).
 *
 * Every numeric threshold used anywhere in the attention derivation pipeline
 * lives here — nothing is hard-coded inline in a route, a service function,
 * or (especially) a React component. Every value is overridable via an env
 * var so this is "configuration-ready" per the brief even though no settings
 * UI exists yet; defaults are conservative to avoid false alarms.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const ATTENTION_CONFIG = {
  /** Node heartbeat policy (§24). offlineAfterMs must be >= staleAfterMs. */
  heartbeat: {
    /** Heartbeat older than this but not yet OFFLINE → STALE (warning). */
    staleAfterMs: envInt("ATTENTION_HEARTBEAT_STALE_MS", 90_000),
    /** Heartbeat older than this → OFFLINE (critical). A single dropped poll (~15-20s cadence) never crosses this alone. */
    offlineAfterMs: envInt("ATTENTION_HEARTBEAT_OFFLINE_MS", 5 * 60_000)
  },

  /** Crash-loop / restart-rate detection (§8). */
  restartLoop: {
    windowMs: envInt("ATTENTION_RESTART_WINDOW_MS", 10 * 60_000),
    warningCount: envInt("ATTENTION_RESTART_WARNING_COUNT", 3),
    criticalCount: envInt("ATTENTION_RESTART_CRITICAL_COUNT", 8),
    /**
     * Restarts observed within this long after a deployment/workload-restart
     * operation successfully completes on the same container are treated as
     * deployment-driven, not a crash loop (avoids false alarms right after a
     * deliberate restart/redeploy — see brief §8).
     */
    postDeploySuppressMs: envInt("ATTENTION_RESTART_POST_DEPLOY_SUPPRESS_MS", 3 * 60_000),
    /** How long a restart sample is retained for rate calculation. */
    sampleRetentionMs: envInt("ATTENTION_RESTART_SAMPLE_RETENTION_MS", 24 * 3600_000)
  },

  /** Resource pressure (§9) — node-level, persisted (small, 1-2 nodes typical). */
  nodeResource: {
    /** How often a node resource sample is recorded (throttle). */
    sampleIntervalMs: envInt("ATTENTION_NODE_SAMPLE_INTERVAL_MS", 60_000),
    sampleRetentionMs: envInt("ATTENTION_NODE_SAMPLE_RETENTION_MS", 24 * 3600_000),
    /** Window over which sustained pressure is evaluated (avoid single-poll spikes). */
    sustainedWindowMs: envInt("ATTENTION_NODE_SUSTAINED_WINDOW_MS", 5 * 60_000),
    /** Minimum samples inside the window required before raising a pressure item. */
    minSamplesForSustained: envInt("ATTENTION_NODE_MIN_SAMPLES", 3),
    cpuWarningPercent: envInt("ATTENTION_NODE_CPU_WARNING_PCT", 85),
    cpuCriticalPercent: envInt("ATTENTION_NODE_CPU_CRITICAL_PCT", 97),
    memWarningPercent: envInt("ATTENTION_NODE_MEM_WARNING_PCT", 85),
    memCriticalPercent: envInt("ATTENTION_NODE_MEM_CRITICAL_PCT", 95),
    diskWarningPercent: envInt("ATTENTION_NODE_DISK_WARNING_PCT", 85),
    diskCriticalPercent: envInt("ATTENTION_NODE_DISK_CRITICAL_PCT", 95)
  },

  /**
   * Container CPU/memory pressure — deliberately NOT persisted (would mean one row
   * per container per poll interval, unbounded by fleet size). An in-memory
   * ring buffer per (nodeId, dockerContainerId) is enough to require
   * sustained pressure across consecutive polls; it resets on process
   * restart, which is an acceptable trade-off documented in ARCHITECTURE.md.
   */
  containerResource: {
    /** Consecutive observations above threshold required before flagging. */
    sustainedSamples: envInt("ATTENTION_CONTAINER_SUSTAINED_SAMPLES", 3),
    cpuWarningPercent: envInt("ATTENTION_CONTAINER_CPU_WARNING_PCT", 90),
    memWarningPercent: envInt("ATTENTION_CONTAINER_MEM_WARNING_PCT", 90),
    memCriticalPercent: envInt("ATTENTION_CONTAINER_MEM_CRITICAL_PCT", 98),
    /** Ring buffer bound per container key. */
    maxTrackedSamples: envInt("ATTENTION_CONTAINER_MAX_SAMPLES", 10)
  },

  /** Stuck-operation detection (§1 "operation stuck beyond allowed timeout"). */
  operation: {
    containerOpStuckAfterMs: envInt("ATTENTION_CONTAINER_OP_STUCK_MS", 5 * 60_000),
    deploymentOpStuckAfterMs: envInt("ATTENTION_DEPLOYMENT_OP_STUCK_MS", 15 * 60_000)
  },

  /** Recent-failures window (§13) — distinct from ongoing attention conditions. */
  recentFailures: {
    windowMs: envInt("ATTENTION_RECENT_FAILURES_WINDOW_MS", 24 * 3600_000),
    limit: envInt("ATTENTION_RECENT_FAILURES_LIMIT", 20)
  },

  /** Agent version freshness (§9 "agent version significantly outdated"). */
  agentVersion: {
    /** Known-current agent version this control plane ships (see agent/src/index.ts AGENT_VERSION). */
    current: "0.4.0"
  },

  /** Certificate expiry (reuses server/services/node-tls.ts thresholds). */
  certificate: {
    warningDays: envInt("ATTENTION_CERT_WARNING_DAYS", 14)
  },

  /** Sync throttle: how often the full attention derivation pass may run. */
  sync: {
    throttleMs: envInt("ATTENTION_SYNC_THROTTLE_MS", 15_000)
  },

  /** How many items the Overview "Needs attention" feed shows at most. */
  feed: {
    maxItems: envInt("ATTENTION_FEED_MAX_ITEMS", 30)
  }
} as const;

/**
 * Resource-pressure thresholds in the wire shape consumed by the UI.
 * Single source of truth: the frontend never hard-codes its own thresholds.
 */
export function resourceThresholds() {
  const r = ATTENTION_CONFIG.nodeResource;
  return {
    cpu: { warning: r.cpuWarningPercent, critical: r.cpuCriticalPercent },
    mem: { warning: r.memWarningPercent, critical: r.memCriticalPercent },
    disk: { warning: r.diskWarningPercent, critical: r.diskCriticalPercent }
  };
}
