import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { listAvailablePublicAddressesForOrg } from "@/server/services/ingress";

/**
 * Organization-safe picker for creating an ingress endpoint: only enabled
 * addresses this organization may actually bind (shared, or dedicated to
 * them) — never platform inventory or another organization's reservation.
 * This is deliberately NOT the platform Public Address management API.
 */
export async function GET(): Promise<Response> {
  try {
    const actor = await requireApiCapability("ingress.view");
    if (!actor.clientAccountId) return ok({ addresses: [] });
    return ok({ addresses: await listAvailablePublicAddressesForOrg(actor.clientAccountId) });
  } catch (error) {
    return fromError(error);
  }
}
