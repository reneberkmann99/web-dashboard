# Managed ingress (Phase 6)

Noderaft uses **Caddy** as its first managed provider. Caddy fits the existing provider-neutral `IngressProvider` model, has a transactional JSON Admin API, and manages ACME certificates without Noderaft handling private keys. It is operated as a dedicated gateway and is not coupled to another product's database schema.

## Traffic and publishing

`Internet → PublicAddress → Caddy gateway → private service DNS → workload service`

The Publish Service flow selects a workload service, one of its declared target ports, HTTP or HTTPS, a verified hostname, an eligible Public Address (automatic selection is recommended), and TLS. Activation probes the derived private backend, installs an id-tagged Caddy route, and reports `Active`, `Pending`, `Backend unavailable`, `DNS invalid`, `TLS failed`, or `Disabled`. Caddy performs ACME issuance and renewal; Noderaft records only certificate lifecycle state and never obtains a certificate private key.

TCP and UDP are deliberately not enabled for Caddy because stock Caddy does not provide those listeners safely without a non-standard layer-4 plugin. The domain model and conflict reservation remain available for a future provider, but activation fails closed as unsupported rather than exposing Docker host ports.

Provider bearer credentials are AES-256-GCM encrypted with `INGRESS_PROVIDER_CREDENTIALS_KEY` and omitted from API reads. Backend addresses are derived from the selected service and current workload node (`service.node-hostname`) and cannot be supplied by a tenant. Verified domain ownership, tenant workload ownership, declared service port validation, Public Address reservations, and port conflict checks are enforced server-side.

Route identity is the endpoint ID. Reconciliation derives the backend from the workload's current `nodeId` on every activation, so relocation replaces only the upstream; hostname, Public Address, route ID, and Caddy-managed certificate identity remain stable. Disable removes the route and retains the endpoint. Delete first removes the public route and then deletes only the endpoint row; workloads, containers, volumes, and domains are untouched.
