"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TabBar } from "@/components/ui/tab-bar";
import { CheckField, Field, FormSection, RepeatRow } from "./field";
import { RESTART_POLICIES, rowId, type ComposeForm, type ServiceForm } from "@/lib/compose-form/model";
import type { FormIssue } from "@/lib/compose-form/validate";

const SERVICE_TABS = [
  "General",
  "Runtime",
  "Ports",
  "Environment",
  "Networks",
  "Storage",
  "Healthcheck",
  "Resources",
  "Advanced"
] as const;

export type ServiceTab = (typeof SERVICE_TABS)[number];

const COMMON_CAPS = [
  "NET_BIND_SERVICE",
  "NET_ADMIN",
  "NET_RAW",
  "SYS_ADMIN",
  "SYS_TIME",
  "SYS_PTRACE",
  "CHOWN",
  "DAC_OVERRIDE",
  "SETUID",
  "SETGID",
  "ALL"
];

/**
 * Structured editor for a single Compose service.
 *
 * Purely local state manipulation — the caller owns the ComposeForm and passes
 * an `onChange` that replaces this service. Nothing here mutates Docker or the
 * database; the edited form is serialized back to compose YAML and pushed
 * through the existing validate → revision → plan → deploy pipeline.
 */
export function ServiceFormEditor({
  service,
  form,
  issues,
  tab,
  onTabChange,
  onChange,
  secretKeys,
  onConvertToSecret,
  onRotateSecret,
  readOnly = false
}: {
  service: ServiceForm;
  form: ComposeForm;
  issues: FormIssue[];
  tab: ServiceTab;
  onTabChange: (tab: ServiceTab) => void;
  onChange: (next: ServiceForm) => void;
  secretKeys: string[];
  onConvertToSecret?: (key: string, value: string) => void;
  onRotateSecret?: (key: string) => void;
  readOnly?: boolean;
}): React.JSX.Element {
  const idBase = `svc-${service.id}`;
  const patch = (partial: Partial<ServiceForm>): void => onChange({ ...service, ...partial });

  const errorFor = (suffix: string): string | null => {
    const match = issues.find((i) => i.severity === "error" && i.path.endsWith(suffix));
    return match?.message ?? null;
  };

  const serviceIssues = useMemo(
    () => issues.filter((i) => i.serviceName === service.name.trim()),
    [issues, service.name]
  );
  const errorCount = serviceIssues.filter((i) => i.severity === "error").length;

  const unsupportedKeys = Object.keys(service.unsupported);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="font-mono text-sm text-text">{service.name || "(unnamed service)"}</h2>
          {errorCount > 0 && <Badge variant="danger">{errorCount} issue{errorCount === 1 ? "" : "s"}</Badge>}
          {unsupportedKeys.length > 0 && <Badge variant="warning">{unsupportedKeys.length} advanced</Badge>}
        </div>
      </div>

      <TabBar tabs={SERVICE_TABS} active={tab} onChange={onTabChange} idPrefix={`${idBase}-section`} />

      <div id={`${idBase}-section-panel-${tab}`} role="tabpanel" aria-labelledby={`${idBase}-section-tab-${tab}`} className="space-y-4">
        {tab === "General" && (
          <FormSection title="General" description="Identity and the process this service runs.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Service name" htmlFor={`${idBase}-name`} error={errorFor(".name")} hint="Compose service key. Renaming recreates the container on deploy.">
                <Input
                  id={`${idBase}-name`}
                  value={service.name}
                  disabled={readOnly}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label="Image" htmlFor={`${idBase}-image`} error={errorFor(".image")} hint="e.g. nginx:1.29 — always pin a tag.">
                <Input
                  id={`${idBase}-image`}
                  value={service.image}
                  disabled={readOnly}
                  placeholder="nginx:1.29"
                  onChange={(e) => patch({ image: e.target.value })}
                />
              </Field>
              <Field label="Command" htmlFor={`${idBase}-command`} hint="Overrides the image CMD. Leave blank to keep the image default.">
                <Input
                  id={`${idBase}-command`}
                  value={service.command}
                  disabled={readOnly}
                  onChange={(e) => patch({ command: e.target.value })}
                />
              </Field>
              <Field label="Entrypoint" htmlFor={`${idBase}-entrypoint`} hint="Overrides the image ENTRYPOINT.">
                <Input
                  id={`${idBase}-entrypoint`}
                  value={service.entrypoint}
                  disabled={readOnly}
                  onChange={(e) => patch({ entrypoint: e.target.value })}
                />
              </Field>
              <Field label="Hostname" htmlFor={`${idBase}-hostname`}>
                <Input
                  id={`${idBase}-hostname`}
                  value={service.hostname}
                  disabled={readOnly}
                  onChange={(e) => patch({ hostname: e.target.value })}
                />
              </Field>
              <Field label="Working directory" htmlFor={`${idBase}-workdir`}>
                <Input
                  id={`${idBase}-workdir`}
                  value={service.workingDir}
                  disabled={readOnly}
                  placeholder="/app"
                  onChange={(e) => patch({ workingDir: e.target.value })}
                />
              </Field>
              <Field label="User" htmlFor={`${idBase}-user`} hint="uid[:gid] or a username present in the image.">
                <Input
                  id={`${idBase}-user`}
                  value={service.user}
                  disabled={readOnly}
                  placeholder="1000:1000"
                  onChange={(e) => patch({ user: e.target.value })}
                />
              </Field>
              <Field label="Depends on" htmlFor={`${idBase}-depends`} error={errorFor(".dependsOn")} hint="Comma-separated service names in this workload.">
                <Input
                  id={`${idBase}-depends`}
                  value={service.dependsOn.join(", ")}
                  disabled={readOnly}
                  onChange={(e) =>
                    patch({ dependsOn: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })
                  }
                />
              </Field>
            </div>
          </FormSection>
        )}

        {tab === "Runtime" && (
          <>
            <FormSection title="Runtime policy" description="How Docker supervises and confines this container.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Restart policy" htmlFor={`${idBase}-restart`} hint="unless-stopped is the safe default for long-running services.">
                  <Select
                    id={`${idBase}-restart`}
                    value={service.restart}
                    disabled={readOnly}
                    onChange={(e) => patch({ restart: e.target.value })}
                  >
                    {RESTART_POLICIES.map((p) => (
                      <option key={p || "unset"} value={p}>
                        {p || "(image default)"}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <CheckField
                  label="Privileged"
                  hint="Grants full host capabilities. High-risk — requires acknowledgement at validation."
                  checked={service.privileged}
                  disabled={readOnly}
                  onChange={(privileged) => patch({ privileged })}
                />
                <CheckField
                  label="Read-only root filesystem"
                  hint="Container filesystem is immutable; writable data must use a volume."
                  checked={service.readOnly}
                  disabled={readOnly}
                  onChange={(v) => patch({ readOnly: v })}
                />
              </div>
            </FormSection>

            <FormSection title="Capabilities" description="Linux capabilities added to or dropped from the container.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Capabilities added" htmlFor={`${idBase}-capadd`} hint={`Comma-separated. Common: ${COMMON_CAPS.slice(0, 4).join(", ")}`}>
                  <Input
                    id={`${idBase}-capadd`}
                    value={service.capAdd.join(", ")}
                    disabled={readOnly}
                    onChange={(e) => patch({ capAdd: e.target.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) })}
                  />
                </Field>
                <Field label="Capabilities dropped" htmlFor={`${idBase}-capdrop`} hint="Drop ALL and add back only what the service needs.">
                  <Input
                    id={`${idBase}-capdrop`}
                    value={service.capDrop.join(", ")}
                    disabled={readOnly}
                    onChange={(e) => patch({ capDrop: e.target.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) })}
                  />
                </Field>
              </div>
            </FormSection>

            <FormSection
              title="Labels"
              description="Docker labels applied to the container."
              actions={
                !readOnly && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => patch({ labels: [...service.labels, { id: rowId("lbl"), key: "", value: "" }] })}
                  >
                    Add label
                  </Button>
                )
              }
            >
              <div className="space-y-2">
                {service.labels.length === 0 && <p className="text-xs text-text-subtle">No labels.</p>}
                {service.labels.map((l, i) => (
                  <RepeatRow
                    key={l.id}
                    removeLabel={`Remove label ${l.key || i + 1}`}
                    onRemove={() => patch({ labels: service.labels.filter((x) => x.id !== l.id) })}
                  >
                    <Field label="Key" className="min-w-[12rem] flex-1">
                      <Input
                        value={l.key}
                        disabled={readOnly}
                        onChange={(e) =>
                          patch({ labels: service.labels.map((x) => (x.id === l.id ? { ...x, key: e.target.value } : x)) })
                        }
                      />
                    </Field>
                    <Field label="Value" className="min-w-[12rem] flex-1">
                      <Input
                        value={l.value}
                        disabled={readOnly}
                        onChange={(e) =>
                          patch({ labels: service.labels.map((x) => (x.id === l.id ? { ...x, value: e.target.value } : x)) })
                        }
                      />
                    </Field>
                  </RepeatRow>
                ))}
              </div>
            </FormSection>
          </>
        )}

        {tab === "Ports" && (
          <FormSection
            title="Published ports"
            description="Host → container port mappings. Leave the published port blank to expose without publishing."
            actions={
              !readOnly && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    patch({
                      ports: [...service.ports, { id: rowId("port"), hostIp: "", published: "", target: "", protocol: "tcp" }]
                    })
                  }
                >
                  Add port
                </Button>
              )
            }
          >
            <div className="space-y-2">
              {service.ports.length === 0 && <p className="text-xs text-text-subtle">No published ports.</p>}
              {service.ports.map((p, i) => {
                const err = issues.find(
                  (issue) => issue.severity === "error" && issue.path.endsWith(`.ports.${i}`)
                );
                return (
                  <div key={p.id} className="space-y-1">
                    <RepeatRow
                      removeLabel={`Remove port row ${i + 1}`}
                      onRemove={() => patch({ ports: service.ports.filter((x) => x.id !== p.id) })}
                    >
                      <Field label="Host IP" className="w-36">
                        <Input
                          value={p.hostIp}
                          placeholder="all interfaces"
                          disabled={readOnly}
                          onChange={(e) => patch({ ports: service.ports.map((x) => (x.id === p.id ? { ...x, hostIp: e.target.value } : x)) })}
                        />
                      </Field>
                      <Field label="Published" className="w-28">
                        <Input
                          value={p.published}
                          placeholder="8080"
                          aria-invalid={Boolean(err)}
                          disabled={readOnly}
                          onChange={(e) => patch({ ports: service.ports.map((x) => (x.id === p.id ? { ...x, published: e.target.value } : x)) })}
                        />
                      </Field>
                      <Field label="Container" className="w-28">
                        <Input
                          value={p.target}
                          placeholder="80"
                          aria-invalid={Boolean(err)}
                          disabled={readOnly}
                          onChange={(e) => patch({ ports: service.ports.map((x) => (x.id === p.id ? { ...x, target: e.target.value } : x)) })}
                        />
                      </Field>
                      <Field label="Protocol" className="w-28">
                        <Select
                          value={p.protocol}
                          disabled={readOnly}
                          onChange={(e) =>
                            patch({
                              ports: service.ports.map((x) =>
                                x.id === p.id ? { ...x, protocol: e.target.value === "udp" ? "udp" : "tcp" } : x
                              )
                            })
                          }
                        >
                          <option value="tcp">tcp</option>
                          <option value="udp">udp</option>
                        </Select>
                      </Field>
                    </RepeatRow>
                    {err && <p className="pl-2 text-xs text-critical-foreground">{err.message}</p>}
                  </div>
                );
              })}
            </div>
          </FormSection>
        )}

        {tab === "Environment" && (
          <FormSection
            title="Environment & secrets"
            description="Secret-backed values show only their key. Plaintext values in this list are stored in the revision — convert anything sensitive to a secret."
            actions={
              !readOnly && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    patch({ environment: [...service.environment, { id: rowId("env"), key: "", value: "", isSecret: false }] })
                  }
                >
                  Add variable
                </Button>
              )
            }
          >
            <div className="space-y-2">
              {service.environment.length === 0 && <p className="text-xs text-text-subtle">No environment variables.</p>}
              {service.environment.map((e, i) => {
                const err = issues.find((issue) => issue.severity === "error" && issue.path.endsWith(`.environment.${i}`));
                return (
                  <div key={e.id} className="space-y-1">
                    <RepeatRow
                      removeLabel={`Remove environment variable ${e.key || i + 1}`}
                      onRemove={() => patch({ environment: service.environment.filter((x) => x.id !== e.id) })}
                    >
                      <Field label="Key" className="min-w-[12rem] flex-1">
                        <Input
                          value={e.key}
                          aria-invalid={Boolean(err)}
                          disabled={readOnly}
                          onChange={(ev) =>
                            patch({ environment: service.environment.map((x) => (x.id === e.id ? { ...x, key: ev.target.value } : x)) })
                          }
                        />
                      </Field>
                      <Field label={e.isSecret ? "Secret reference" : "Value"} className="min-w-[14rem] flex-[2]">
                        {e.isSecret ? (
                          <div className="flex h-control items-center gap-2 rounded-control border border-border bg-surface-hull px-3">
                            <Badge variant="info">secret</Badge>
                            <span className="truncate font-mono text-xs text-text-muted">{e.value}</span>
                          </div>
                        ) : (
                          <Input
                            value={e.value}
                            disabled={readOnly}
                            onChange={(ev) =>
                              patch({ environment: service.environment.map((x) => (x.id === e.id ? { ...x, value: ev.target.value } : x)) })
                            }
                          />
                        )}
                      </Field>
                      {!readOnly && e.isSecret && onRotateSecret && (
                        <button
                          type="button"
                          onClick={() => onRotateSecret(e.key.trim())}
                          className="h-control-sm shrink-0 rounded-control border border-border px-3 text-xs text-text-muted hover:border-border-strong hover:text-text"
                        >
                          Rotate secret
                        </button>
                      )}
                      {!readOnly && !e.isSecret && onConvertToSecret && e.key.trim() && (
                        <button
                          type="button"
                          onClick={() => onConvertToSecret(e.key.trim(), e.value)}
                          className="h-control-sm shrink-0 rounded-control border border-border px-3 text-xs text-text-muted hover:border-border-strong hover:text-text"
                        >
                          Convert to secret
                        </button>
                      )}
                    </RepeatRow>
                    {err && <p className="pl-2 text-xs text-critical-foreground">{err.message}</p>}
                  </div>
                );
              })}
              {secretKeys.length > 0 && (
                <p className="text-xs text-text-subtle">
                  Declared secrets for this workload: {secretKeys.join(", ")}. Values are never shown or diffed.
                </p>
              )}
            </div>
          </FormSection>
        )}

        {tab === "Networks" && (
          <FormSection
            title="Networks"
            description="Networks this service attaches to. Workload-created networks are declared in this workload; external/shared networks already exist on the node."
            actions={
              !readOnly && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => patch({ networks: [...service.networks, { id: rowId("net"), name: "", aliases: [] }] })}
                >
                  Attach network
                </Button>
              )
            }
          >
            <div className="space-y-2">
              {service.networks.length === 0 && (
                <p className="text-xs text-text-subtle">Not attached to any explicit network — Compose uses the default workload network.</p>
              )}
              {service.networks.map((n, i) => {
                const err = issues.find((issue) => issue.severity === "error" && issue.path.endsWith(`.networks.${i}`));
                const top = form.networks.find((t) => t.name.trim() === n.name.trim());
                return (
                  <div key={n.id} className="space-y-1">
                    <RepeatRow
                      removeLabel={`Detach network ${n.name || i + 1}`}
                      onRemove={() => patch({ networks: service.networks.filter((x) => x.id !== n.id) })}
                    >
                      <Field label="Network" className="min-w-[12rem] flex-1">
                        <Select
                          value={n.name}
                          aria-invalid={Boolean(err)}
                          disabled={readOnly}
                          onChange={(e) => patch({ networks: service.networks.map((x) => (x.id === n.id ? { ...x, name: e.target.value } : x)) })}
                        >
                          <option value="">(select a network)</option>
                          {form.networks.map((t) => (
                            <option key={t.id} value={t.name}>
                              {t.name}
                              {t.external ? " (external/shared)" : " (workload-created)"}
                            </option>
                          ))}
                          {n.name && !top && <option value={n.name}>{n.name} (undeclared)</option>}
                        </Select>
                      </Field>
                      <Field label="Aliases" className="min-w-[12rem] flex-1" >
                        <Input
                          value={n.aliases.join(", ")}
                          disabled={readOnly}
                          placeholder="comma-separated"
                          onChange={(e) =>
                            patch({
                              networks: service.networks.map((x) =>
                                x.id === n.id ? { ...x, aliases: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x
                              )
                            })
                          }
                        />
                      </Field>
                      {top && <Badge variant={top.external ? "warning" : "default"}>{top.external ? "external / shared" : "workload-created"}</Badge>}
                    </RepeatRow>
                    {err && <p className="pl-2 text-xs text-critical-foreground">{err.message}</p>}
                  </div>
                );
              })}
            </div>
          </FormSection>
        )}

        {tab === "Storage" && (
          <FormSection
            title="Storage"
            description="Named volumes are managed by Docker and preserved across deploys. Bind mounts point at host paths on this node."
            actions={
              !readOnly && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    patch({
                      volumes: [...service.volumes, { id: rowId("vol"), kind: "volume", source: "", target: "", readOnly: false, longForm: false }]
                    })
                  }
                >
                  Add mount
                </Button>
              )
            }
          >
            <div className="space-y-2">
              {service.volumes.length === 0 && <p className="text-xs text-text-subtle">No mounts.</p>}
              {service.volumes.map((v, i) => {
                const err = issues.find((issue) => issue.severity === "error" && issue.path.endsWith(`.volumes.${i}`));
                const warn = issues.find((issue) => issue.severity === "warning" && issue.path.endsWith(`.volumes.${i}`));
                return (
                  <div key={v.id} className="space-y-1">
                    <RepeatRow
                      removeLabel={`Remove mount ${v.target || i + 1}`}
                      onRemove={() => patch({ volumes: service.volumes.filter((x) => x.id !== v.id) })}
                    >
                      <Field label="Type" className="w-36">
                        <Select
                          value={v.kind}
                          disabled={readOnly}
                          onChange={(e) =>
                            patch({
                              volumes: service.volumes.map((x) => (x.id === v.id ? { ...x, kind: e.target.value === "bind" ? "bind" : "volume" } : x))
                            })
                          }
                        >
                          <option value="volume">Named volume</option>
                          <option value="bind">Bind mount</option>
                        </Select>
                      </Field>
                      <Field label={v.kind === "bind" ? "Host path" : "Volume name"} className="min-w-[12rem] flex-1">
                        <Input
                          value={v.source}
                          aria-invalid={Boolean(err)}
                          disabled={readOnly}
                          placeholder={v.kind === "bind" ? "/srv/data" : "app-data"}
                          onChange={(e) => patch({ volumes: service.volumes.map((x) => (x.id === v.id ? { ...x, source: e.target.value } : x)) })}
                        />
                      </Field>
                      <Field label="Container path" className="min-w-[12rem] flex-1">
                        <Input
                          value={v.target}
                          aria-invalid={Boolean(err)}
                          disabled={readOnly}
                          placeholder="/data"
                          onChange={(e) => patch({ volumes: service.volumes.map((x) => (x.id === v.id ? { ...x, target: e.target.value } : x)) })}
                        />
                      </Field>
                      <label className="mb-2 flex items-center gap-2 text-xs text-text-muted">
                        <input
                          type="checkbox"
                          checked={v.readOnly}
                          disabled={readOnly}
                          className="h-4 w-4 accent-brand"
                          onChange={(e) => patch({ volumes: service.volumes.map((x) => (x.id === v.id ? { ...x, readOnly: e.target.checked } : x)) })}
                        />
                        read-only
                      </label>
                    </RepeatRow>
                    {err && <p className="pl-2 text-xs text-critical-foreground">{err.message}</p>}
                    {!err && warn && <p className="pl-2 text-xs text-warning-foreground">{warn.message}</p>}
                  </div>
                );
              })}
            </div>
          </FormSection>
        )}

        {tab === "Healthcheck" && (
          <FormSection title="Healthcheck" description="Docker health probe. Noderaft uses it to verify a deployment converged.">
            <CheckField
              label="Enable healthcheck"
              hint="When disabled the image's own HEALTHCHECK (if any) applies."
              checked={service.healthcheck.enabled}
              disabled={readOnly}
              onChange={(enabled) =>
                patch({ healthcheck: { ...service.healthcheck, enabled, testKind: enabled && service.healthcheck.testKind === "none" ? "shell" : service.healthcheck.testKind } })
              }
            />
            {service.healthcheck.enabled && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Probe kind" htmlFor={`${idBase}-hc-kind`}>
                  <Select
                    id={`${idBase}-hc-kind`}
                    value={service.healthcheck.testKind}
                    disabled={readOnly}
                    onChange={(e) =>
                      patch({ healthcheck: { ...service.healthcheck, testKind: e.target.value as "none" | "shell" | "exec" } })
                    }
                  >
                    <option value="shell">Shell command (CMD-SHELL)</option>
                    <option value="exec">Exec argv (CMD)</option>
                    <option value="none">Disable image healthcheck (NONE)</option>
                  </Select>
                </Field>
                <Field label="Command" htmlFor={`${idBase}-hc-test`} error={errorFor(".healthcheck.test")}>
                  <Input
                    id={`${idBase}-hc-test`}
                    value={service.healthcheck.test}
                    disabled={readOnly || service.healthcheck.testKind === "none"}
                    placeholder="curl -f http://localhost/ || exit 1"
                    onChange={(e) => patch({ healthcheck: { ...service.healthcheck, test: e.target.value } })}
                  />
                </Field>
                <Field label="Interval" htmlFor={`${idBase}-hc-interval`} error={errorFor(".healthcheck.interval")} hint="e.g. 30s">
                  <Input
                    id={`${idBase}-hc-interval`}
                    value={service.healthcheck.interval}
                    disabled={readOnly}
                    onChange={(e) => patch({ healthcheck: { ...service.healthcheck, interval: e.target.value } })}
                  />
                </Field>
                <Field label="Timeout" htmlFor={`${idBase}-hc-timeout`} error={errorFor(".healthcheck.timeout")} hint="e.g. 5s">
                  <Input
                    id={`${idBase}-hc-timeout`}
                    value={service.healthcheck.timeout}
                    disabled={readOnly}
                    onChange={(e) => patch({ healthcheck: { ...service.healthcheck, timeout: e.target.value } })}
                  />
                </Field>
                <Field label="Retries" htmlFor={`${idBase}-hc-retries`} error={errorFor(".healthcheck.retries")}>
                  <Input
                    id={`${idBase}-hc-retries`}
                    value={service.healthcheck.retries}
                    disabled={readOnly}
                    onChange={(e) => patch({ healthcheck: { ...service.healthcheck, retries: e.target.value } })}
                  />
                </Field>
                <Field label="Start period" htmlFor={`${idBase}-hc-start`} error={errorFor(".healthcheck.startPeriod")} hint="Grace before failures count, e.g. 10s">
                  <Input
                    id={`${idBase}-hc-start`}
                    value={service.healthcheck.startPeriod}
                    disabled={readOnly}
                    onChange={(e) => patch({ healthcheck: { ...service.healthcheck, startPeriod: e.target.value } })}
                  />
                </Field>
              </div>
            )}
          </FormSection>
        )}

        {tab === "Resources" && (
          <FormSection title="Resource limits" description="Caps the container's memory and CPU. Leave blank for unlimited (host-bound).">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Memory limit" htmlFor={`${idBase}-mem`} error={errorFor(".resources.memoryLimit")} hint="e.g. 512m, 2g">
                <Input
                  id={`${idBase}-mem`}
                  value={service.resources.memoryLimit}
                  disabled={readOnly}
                  onChange={(e) => patch({ resources: { ...service.resources, memoryLimit: e.target.value } })}
                />
              </Field>
              <Field label="CPU limit" htmlFor={`${idBase}-cpu`} error={errorFor(".resources.cpuLimit")} hint="Cores, e.g. 0.5 or 2">
                <Input
                  id={`${idBase}-cpu`}
                  value={service.resources.cpuLimit}
                  disabled={readOnly}
                  onChange={(e) => patch({ resources: { ...service.resources, cpuLimit: e.target.value } })}
                />
              </Field>
              <Field label="Memory reservation" htmlFor={`${idBase}-memres`} error={errorFor(".resources.memoryReservation")} hint="Soft guarantee, e.g. 128m">
                <Input
                  id={`${idBase}-memres`}
                  value={service.resources.memoryReservation}
                  disabled={readOnly}
                  onChange={(e) => patch({ resources: { ...service.resources, memoryReservation: e.target.value } })}
                />
              </Field>
              <Field label="CPU reservation" htmlFor={`${idBase}-cpures`} error={errorFor(".resources.cpuReservation")} hint="Soft guarantee in cores">
                <Input
                  id={`${idBase}-cpures`}
                  value={service.resources.cpuReservation}
                  disabled={readOnly || service.resources.style === "shorthand"}
                  onChange={(e) => patch({ resources: { ...service.resources, cpuReservation: e.target.value } })}
                />
              </Field>
            </div>
            <p className="mt-2 text-xs text-text-subtle">
              Written as {service.resources.style === "shorthand" ? "mem_limit / cpus (Compose shorthand)" : "deploy.resources.limits"} — matching how this workload already declares limits.
            </p>
          </FormSection>
        )}

        {tab === "Advanced" && (
          <FormSection
            title="Advanced / unsupported runtime options"
            description="Options Noderaft cannot safely represent as form fields. They are preserved exactly as written and round-tripped into every revision — edit them in the Compose source tab."
          >
            {unsupportedKeys.length === 0 ? (
              <p className="text-xs text-text-subtle">This service uses no options outside the structured form.</p>
            ) : (
              <Textarea
                readOnly
                spellCheck={false}
                rows={Math.min(20, unsupportedKeys.length * 3 + 3)}
                className="font-mono text-xs"
                aria-label={`Unsupported runtime options for ${service.name}`}
                value={JSON.stringify(service.unsupported, null, 2)}
              />
            )}
          </FormSection>
        )}
      </div>
    </div>
  );
}

export { SERVICE_TABS };
