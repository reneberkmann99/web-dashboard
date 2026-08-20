import fs from "node:fs";
import path from "node:path";

/**
 * Agent deployment state directory (Phase 6B.3).
 *
 * Noderaft-owned files live ONLY under <state-dir>/deployments/<deploymentId>/.
 * Externally managed Compose directories are never touched. IDs are strictly
 * sanitized (alphanumeric + _/-, no '/', '.', '..'), which structurally
 * prevents traversal; a resolve-prefix containment check is added as
 * defense-in-depth.
 */

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function resolveStateDir(): string {
  if (process.env.AGENT_STATE_DIR) return process.env.AGENT_STATE_DIR;
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "hostpanel");
  if (process.env.HOME) return path.join(process.env.HOME, ".local", "share", "hostpanel");
  return "/var/lib/hostpanel";
}

export function sanitizeId(id: string): string {
  if (!ID_RE.test(id)) throw new Error("Invalid deployment id");
  return id;
}

function assertContained(p: string): string {
  const resolved = path.resolve(p);
  const root = path.resolve(resolveStateDir());
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Path escapes state directory");
  }
  return resolved;
}

export function deploymentDir(deploymentId: string): string {
  return assertContained(path.join(resolveStateDir(), "deployments", sanitizeId(deploymentId)));
}

export function revisionDir(deploymentId: string, revisionNumber: number): string {
  return path.join(deploymentDir(deploymentId), "revisions", String(revisionNumber).padStart(6, "0"));
}

export function currentLink(deploymentId: string): string {
  return path.join(deploymentDir(deploymentId), "current");
}

export function operationsDir(deploymentId: string): string {
  return path.join(deploymentDir(deploymentId), "operations");
}

/** Materialize a candidate revision. Does NOT repoint `current`. */
export function materializeRevision(
  deploymentId: string,
  revisionNumber: number,
  compose: string,
  env: Record<string, string>,
  projectName: string
): void {
  const dir = revisionDir(deploymentId, revisionNumber);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "compose.yml"), compose, { mode: 0o600 });
  // Non-secret env only. Secret values are NEVER persisted here.
  fs.writeFileSync(path.join(dir, "env.json"), JSON.stringify(env), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ projectName }), { mode: 0o600 });
}

export function readRevision(deploymentId: string, revisionNumber: number): {
  compose: string;
  env: Record<string, string>;
  projectName: string;
} | null {
  const dir = revisionDir(deploymentId, revisionNumber);
  try {
    const compose = fs.readFileSync(path.join(dir, "compose.yml"), "utf8");
    const env = JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8")) as Record<string, string>;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { projectName?: string };
    return { compose, env, projectName: meta.projectName ?? "" };
  } catch {
    return null;
  }
}

/** Atomically repoint `current` to a revision dir only after convergence. */
export function setCurrent(deploymentId: string, revisionNumber: number): void {
  const target = revisionDir(deploymentId, revisionNumber);
  const link = currentLink(deploymentId);
  const tmp = `${link}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  try {
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, link);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new Error("Failed to switch current revision");
  }
}

export function getCurrentRevisionNumber(deploymentId: string): number | null {
  try {
    const link = fs.readlinkSync(currentLink(deploymentId));
    const base = path.basename(link);
    const n = Number(base);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ---- Operation journal (replay defense + crash recovery) ------------------

export type JournalEntry = {
  operationId: string;
  deploymentId: string;
  revisionId?: string;
  action: string;
  state: string;
  startedAt: string;
  finishedAt?: string;
};

export function writeJournal(deploymentId: string, entry: JournalEntry): void {
  const dir = operationsDir(deploymentId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${entry.operationId}.json`), JSON.stringify(entry), { mode: 0o600 });
}

export function readJournal(deploymentId: string, operationId: string): JournalEntry | null {
  try {
    const raw = fs.readFileSync(path.join(operationsDir(deploymentId), `${operationId}.json`), "utf8");
    return JSON.parse(raw) as JournalEntry;
  } catch {
    return null;
  }
}
