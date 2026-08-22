import type { IngressExposureType } from "@prisma/client";

export type ManagedRoute = {
  id: string;
  exposure: IngressExposureType;
  hostname: string | null;
  backendUrl: string;
};

export interface ManagedIngressProvider {
  upsert(route: ManagedRoute): Promise<void>;
  remove(routeId: string): Promise<void>;
  probe(route: ManagedRoute): Promise<{ ok: boolean; detail?: string }>;
  verifyTls(route: ManagedRoute): Promise<{ status: "ISSUED" | "PENDING" | "DNS_INVALID" | "FAILED"; detail?: string }>;
}
