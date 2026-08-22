import { decryptSecret } from "@/server/security/crypto";
import { CaddyIngressProvider } from "./caddy";
import type { ManagedIngressProvider } from "./types";

export function managedProviderFor(provider: { kind: string; config: unknown; credentialEncrypted: string | null }): ManagedIngressProvider | null {
  if (provider.kind !== "CADDY") return null;
  const config = (provider.config ?? {}) as { adminUrl?: string };
  if (!config.adminUrl) throw new Error("CADDY_ADMIN_URL_REQUIRED");
  return new CaddyIngressProvider({
    adminUrl: config.adminUrl,
    bearerToken: provider.credentialEncrypted ? decryptSecret(provider.credentialEncrypted, "INGRESS_PROVIDER_CREDENTIALS") : undefined
  });
}
