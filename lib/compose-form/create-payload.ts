import type { ComposeForm } from "./model";
import { serializeForm } from "./serialize";

const SECRET_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}$/;

/**
 * Extract secret reference keys from a structured form. Any environment
 * entry whose value is exactly `${KEY}` is treated as a Noderaft-managed
 * secret reference — the same convention the parse/serialize round-trip
 * uses, so a form-authored secret reference is registered on the deployment
 * from the very first revision instead of silently staying a literal.
 */
export function extractSecretReferences(form: ComposeForm): string[] {
  const refs = new Set<string>();
  for (const svc of form.services) {
    for (const env of svc.environment) {
      const key = env.key.trim();
      const match = env.value.trim().match(SECRET_REF_RE);
      if (key.length > 0 && match) refs.add(match[1]);
    }
  }
  return Array.from(refs);
}

/**
 * Build the shared create-deployment payload from the structured form.
 *
 * The compose document is the single source of truth — the same document the
 * deployment editor later loads as revision #1 — so both the Form wizard and
 * the Compose YAML path produce identical Deployment/DeploymentRevision rows
 * through the EXISTING create endpoint. There is deliberately no "simple
 * workload" backend: `environment` (the workload-level overlay) stays empty
 * because every value already lives inside the compose services.
 */
export function buildCreatePayload(
  form: ComposeForm
): { compose: string; environment: Record<string, string>; secretReferences: string[] } {
  return {
    compose: serializeForm(form),
    environment: {},
    secretReferences: extractSecretReferences(form)
  };
}
