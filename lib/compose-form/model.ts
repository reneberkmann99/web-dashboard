/**
 * Structured Compose form model.
 *
 * This is a LOSSLESS, round-trippable projection of a Docker Compose file into
 * flat form-friendly structures. Everything Noderaft can safely represent as a
 * structured control becomes a typed field; everything else is preserved
 * verbatim in `unsupported` buckets so the YAML round-trips unchanged.
 *
 * The model is deliberately pure data (no React, no Prisma, no Docker) so it
 * can be unit-tested and reused by both the form editor and the creation
 * wizard. It NEVER performs a mutation — serializing produces compose YAML
 * that is fed into the EXISTING revision → plan → deploy pipeline.
 */

export type PortEntry = {
  /** Stable row id for React keys / edit tracking (not serialized). */
  id: string;
  hostIp: string;
  published: string;
  target: string;
  protocol: "tcp" | "udp";
  /** Long-form-only extras (e.g. `mode: host`) preserved verbatim. */
  extra?: Record<string, unknown>;
};

export type EnvEntry = {
  id: string;
  key: string;
  /** For secret refs this is the `${KEY}` interpolation, never a plaintext value. */
  value: string;
  /** True when `value` is exactly `${key}` and `key` is a declared secret reference. */
  isSecret: boolean;
};

export type NetworkAttachment = {
  id: string;
  name: string;
  aliases: string[];
  /** Long-form-only extras (ipv4_address, …) preserved verbatim. */
  extra?: Record<string, unknown>;
};

export type VolumeMount = {
  id: string;
  kind: "volume" | "bind";
  source: string;
  target: string;
  readOnly: boolean;
  /** Long-form-only extras preserved verbatim. */
  extra?: Record<string, unknown>;
  /** True when the original entry used compose long syntax (object form). */
  longForm: boolean;
};

export type HealthcheckForm = {
  enabled: boolean;
  /** Shell command string (CMD-SHELL form) or joined CMD argv. */
  testKind: "none" | "shell" | "exec";
  test: string;
  interval: string;
  timeout: string;
  retries: string;
  startPeriod: string;
  extra?: Record<string, unknown>;
};

export type ResourcesForm = {
  /** e.g. "512m", "1g" — mapped to deploy.resources.limits.memory or mem_limit. */
  memoryLimit: string;
  /** e.g. "0.5", "2" — mapped to deploy.resources.limits.cpus or cpus. */
  cpuLimit: string;
  memoryReservation: string;
  cpuReservation: string;
  /** Where limits came from so serialization writes them back to the same place. */
  style: "deploy" | "shorthand";
};

export type ServiceForm = {
  id: string;
  /** Compose service key. */
  name: string;
  image: string;
  command: string;
  entrypoint: string;
  hostname: string;
  workingDir: string;
  user: string;
  restart: string;
  privileged: boolean;
  readOnly: boolean;
  capAdd: string[];
  capDrop: string[];
  ports: PortEntry[];
  environment: EnvEntry[];
  networks: NetworkAttachment[];
  volumes: VolumeMount[];
  healthcheck: HealthcheckForm;
  resources: ResourcesForm;
  labels: Array<{ id: string; key: string; value: string }>;
  dependsOn: string[];
  /**
   * Any compose service key Noderaft has no structured control for. Shown
   * read-only under "Advanced / unsupported runtime option" and written back
   * verbatim on serialize — never silently dropped.
   */
  unsupported: Record<string, unknown>;
  /** True when `command`/`entrypoint` were arrays in the source (round-trip). */
  commandWasArray: boolean;
  entrypointWasArray: boolean;
  /**
   * Original raw command/entrypoint values. When the form string still equals
   * the joined original, serialization emits the ORIGINAL node verbatim so an
   * untouched quoted argv array round-trips exactly.
   */
  commandRaw?: unknown;
  entrypointRaw?: unknown;
  /** True when environment was an array in the source (round-trip). */
  environmentWasArray: boolean;
  /** True when labels were an array in the source (round-trip). */
  labelsWereArray: boolean;
};

export type TopLevelNetwork = {
  id: string;
  name: string;
  external: boolean;
  driver: string;
  extra: Record<string, unknown>;
};

export type TopLevelVolume = {
  id: string;
  name: string;
  external: boolean;
  driver: string;
  extra: Record<string, unknown>;
};

export type ComposeForm = {
  services: ServiceForm[];
  networks: TopLevelNetwork[];
  volumes: TopLevelVolume[];
  /** Top-level compose keys other than services/networks/volumes, preserved. */
  unsupportedTopLevel: Record<string, unknown>;
  /** Compose keys the parser could not interpret at all (invalid YAML). */
  parseError: string | null;
};

export const RESTART_POLICIES = ["", "no", "always", "on-failure", "unless-stopped"] as const;

/** Deterministic-enough row id generator (client + server safe, no crypto dep). */
let rowCounter = 0;
export function rowId(prefix = "row"): string {
  rowCounter += 1;
  return `${prefix}-${rowCounter}`;
}

export function emptyHealthcheck(): HealthcheckForm {
  return { enabled: false, testKind: "none", test: "", interval: "", timeout: "", retries: "", startPeriod: "" };
}

export function emptyResources(): ResourcesForm {
  return { memoryLimit: "", cpuLimit: "", memoryReservation: "", cpuReservation: "", style: "deploy" };
}

export function emptyService(name = "app"): ServiceForm {
  return {
    id: rowId("svc"),
    name,
    image: "",
    command: "",
    entrypoint: "",
    hostname: "",
    workingDir: "",
    user: "",
    restart: "unless-stopped",
    privileged: false,
    readOnly: false,
    capAdd: [],
    capDrop: [],
    ports: [],
    environment: [],
    networks: [],
    volumes: [],
    healthcheck: emptyHealthcheck(),
    resources: emptyResources(),
    labels: [],
    dependsOn: [],
    unsupported: {},
    commandWasArray: false,
    entrypointWasArray: false,
    environmentWasArray: false,
    labelsWereArray: false
  };
}

export function emptyForm(): ComposeForm {
  return { services: [], networks: [], volumes: [], unsupportedTopLevel: {}, parseError: null };
}
