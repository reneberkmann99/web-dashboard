"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { CheckField, Field, FormSection, RepeatRow } from "./field";
import { ServiceFormEditor, type ServiceTab } from "./service-form";
import { emptyService, rowId, type ComposeForm, type ServiceForm } from "@/lib/compose-form/model";
import type { FormIssue } from "@/lib/compose-form/validate";

/**
 * Workload-level structured editor: service picker + per-service form +
 * workload-scoped networks/volumes. Pure local state; the parent turns the
 * ComposeForm back into YAML for the existing revision/plan/deploy pipeline.
 */
export function WorkloadFormEditor({
  form,
  issues,
  onChange,
  secretKeys,
  onConvertToSecret,
  onRotateSecret,
  onRemoveService,
  readOnly = false,
  general
}: {
  form: ComposeForm;
  issues: FormIssue[];
  onChange: (next: ComposeForm) => void;
  secretKeys: string[];
  onConvertToSecret?: (key: string, value: string) => void;
  onRotateSecret?: (key: string) => void;
  /** When provided, the "Remove service" action routes through the managed deletion flow. */
  onRemoveService?: (serviceName: string) => void;
  readOnly?: boolean;
  /** Workload-level (non-compose) metadata panel rendered above the services. */
  general?: React.ReactNode;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(form.services[0]?.id ?? null);
  const [serviceTab, setServiceTab] = useState<ServiceTab>("General");

  const selected = form.services.find((s) => s.id === selectedId) ?? form.services[0] ?? null;

  const updateService = (next: ServiceForm): void => {
    onChange({ ...form, services: form.services.map((s) => (s.id === next.id ? next : s)) });
  };

  const addService = (): void => {
    const base = `service-${form.services.length + 1}`;
    let name = base;
    let i = 2;
    while (form.services.some((s) => s.name === name)) {
      name = `${base}-${i}`;
      i += 1;
    }
    const svc = emptyService(name);
    onChange({ ...form, services: [...form.services, svc] });
    setSelectedId(svc.id);
    setServiceTab("General");
  };

  const issuesFor = (name: string): number =>
    issues.filter((i) => i.severity === "error" && i.serviceName === name).length;

  return (
    <div className="space-y-5">
      {general}

      <FormSection
        title="Services"
        description="Each service becomes one container in this workload."
        actions={
          !readOnly && (
            <Button size="sm" variant="secondary" onClick={addService}>
              Add service
            </Button>
          )
        }
      >
        <div className="flex flex-wrap gap-2">
          {form.services.length === 0 && <p className="text-xs text-text-subtle">No services defined yet.</p>}
          {form.services.map((s) => {
            const errCount = issuesFor(s.name.trim());
            const active = s.id === selected?.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedId(s.id)}
                aria-pressed={active}
                className={
                  active
                    ? "flex items-center gap-2 rounded-control border border-selected-border/50 bg-selected px-3 py-2 text-sm text-brand-hover"
                    : "flex items-center gap-2 rounded-control border border-border bg-surface-raised px-3 py-2 text-sm text-text-muted hover:border-border-strong hover:text-text"
                }
              >
                <span className="font-mono text-xs">{s.name || "(unnamed)"}</span>
                {errCount > 0 && <Badge variant="danger">{errCount}</Badge>}
              </button>
            );
          })}
        </div>

        {selected && !readOnly && onRemoveService && (
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={() => onRemoveService(selected.name.trim())}>
              Remove “{selected.name}” from this workload
            </Button>
            <p className="mt-1 text-xs text-text-subtle">
              Removing a service edits the workload definition. Nothing is removed from Docker until you review the plan and deploy.
            </p>
          </div>
        )}
      </FormSection>

      {selected && (
        <ServiceFormEditor
          service={selected}
          form={form}
          issues={issues}
          tab={serviceTab}
          onTabChange={setServiceTab}
          onChange={updateService}
          secretKeys={secretKeys}
          onConvertToSecret={onConvertToSecret}
          onRotateSecret={onRotateSecret}
          readOnly={readOnly}
        />
      )}

      <FormSection
        title="Workload networks"
        description="Networks declared by this workload. External networks already exist on the node and are never created or removed by Noderaft."
        actions={
          !readOnly && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                onChange({ ...form, networks: [...form.networks, { id: rowId("tnet"), name: "", external: false, driver: "", extra: {} }] })
              }
            >
              Add network
            </Button>
          )
        }
      >
        <div className="space-y-2">
          {form.networks.length === 0 && <p className="text-xs text-text-subtle">No workload networks declared.</p>}
          {form.networks.map((n) => (
            <RepeatRow
              key={n.id}
              removeLabel={`Remove network ${n.name}`}
              onRemove={() => onChange({ ...form, networks: form.networks.filter((x) => x.id !== n.id) })}
            >
              <Field label="Name" className="min-w-[12rem] flex-1">
                <Input
                  value={n.name}
                  disabled={readOnly}
                  onChange={(e) => onChange({ ...form, networks: form.networks.map((x) => (x.id === n.id ? { ...x, name: e.target.value } : x)) })}
                />
              </Field>
              <Field label="Driver" className="w-40">
                <Input
                  value={n.driver}
                  disabled={readOnly}
                  placeholder="bridge"
                  onChange={(e) => onChange({ ...form, networks: form.networks.map((x) => (x.id === n.id ? { ...x, driver: e.target.value } : x)) })}
                />
              </Field>
              <div className="mb-0.5 w-64">
                <CheckField
                  label="External / shared"
                  hint="Already exists on the node; Noderaft attaches only."
                  checked={n.external}
                  disabled={readOnly}
                  onChange={(external) => onChange({ ...form, networks: form.networks.map((x) => (x.id === n.id ? { ...x, external } : x)) })}
                />
              </div>
            </RepeatRow>
          ))}
        </div>
      </FormSection>

      <FormSection
        title="Workload volumes"
        description="Named volumes declared by this workload. Data is preserved across deploys and is never deleted by a workload delete."
        actions={
          !readOnly && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                onChange({ ...form, volumes: [...form.volumes, { id: rowId("tvol"), name: "", external: false, driver: "", extra: {} }] })
              }
            >
              Add volume
            </Button>
          )
        }
      >
        <div className="space-y-2">
          {form.volumes.length === 0 && <p className="text-xs text-text-subtle">No workload volumes declared.</p>}
          {form.volumes.map((v) => (
            <RepeatRow
              key={v.id}
              removeLabel={`Remove volume ${v.name}`}
              onRemove={() => onChange({ ...form, volumes: form.volumes.filter((x) => x.id !== v.id) })}
            >
              <Field label="Name" className="min-w-[12rem] flex-1">
                <Input
                  value={v.name}
                  disabled={readOnly}
                  onChange={(e) => onChange({ ...form, volumes: form.volumes.map((x) => (x.id === v.id ? { ...x, name: e.target.value } : x)) })}
                />
              </Field>
              <Field label="Driver" className="w-40">
                <Select
                  value={v.driver}
                  disabled={readOnly}
                  onChange={(e) => onChange({ ...form, volumes: form.volumes.map((x) => (x.id === v.id ? { ...x, driver: e.target.value } : x)) })}
                >
                  <option value="">local (default)</option>
                  <option value="local">local</option>
                </Select>
              </Field>
              <div className="mb-0.5 w-64">
                <CheckField
                  label="External / shared"
                  hint="Already exists on the node; Noderaft never creates or deletes it."
                  checked={v.external}
                  disabled={readOnly}
                  onChange={(external) => onChange({ ...form, volumes: form.volumes.map((x) => (x.id === v.id ? { ...x, external } : x)) })}
                />
              </div>
            </RepeatRow>
          ))}
        </div>
      </FormSection>

      {Object.keys(form.unsupportedTopLevel).length > 0 && (
        <FormSection
          title="Advanced / unsupported top-level options"
          description="Preserved verbatim in every revision Noderaft writes. Edit them in the Compose source tab."
        >
          <pre className="max-h-48 overflow-auto rounded-control border border-border bg-surface-hull p-3 font-mono text-xs text-text-muted">
            {JSON.stringify(form.unsupportedTopLevel, null, 2)}
          </pre>
        </FormSection>
      )}
    </div>
  );
}
