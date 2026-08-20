# Phase 6E production preflight remediation (2026-08-20)

This preflight used the Phase 6D attention state, workload/container views,
Activity, logs and deployment state to diagnose two real production
conditions. It did not suppress either condition, use `docker compose down`,
remove volumes/networks, touch Mailcow, or mutate unrelated workloads.

## Test Nginx drift and failed deployment

Root cause: an orphaned `test-app` container from revision 1 still belonged to
Compose project `test-nginx` and published host TCP/8080. The desired/current
revision 3 contains services `backend`, `database`, `frontend`, `redis`, and
`worker`; it no longer contains `test-app`. The desired `testapp-frontend`
could therefore be created but not started because its own TCP/8080 publish
failed with `Bind for 0.0.0.0:8080 failed: port is already allocated`.
HostPanel intentionally does not use Compose `--remove-orphans`, so repeated
deploys could not silently delete the obsolete container.

Evidence:

- HostPanel active conditions: `WORKLOAD_DRIFTED` and `DEPLOYMENT_FAILED` for
  Test Nginx;
- deployment runtime state `DRIFTED`, three recent operations failed with the
  same port-allocation error;
- `test-app` held TCP/8080 and carried Compose service label `test-app`;
- revision 3 contained no `test-app` service;
- `test-app` had no volumes and no HostPanel container/assignment reference;
- its only network attachment was the existing shared
  `test-nginx_default` network.

Safe mutation performed:

1. stopped and removed only the orphaned `test-app` container;
2. removed only the never-started, data-less `testapp-frontend` shell left by
   the failed attempt;
3. generated a fresh plan and deployed revision 3 through HostPanel's public
   admin API (operation `cmt1gwao301otnw013qk2a52w`).

Final state: operation succeeded with `CONVERGED_HEALTHY`; all five desired
services were running (healthchecked services healthy). HostPanel's normal
attention sync set both real condition rows' `resolvedAt` to
`2026-08-20 11:59:32.470 UTC`. No condition was manually hidden or resolved.

## `esphome` unhealthy

Root cause: the container had recently been intentionally moved from the new
Device Builder default port 6052 to VPN-facing port 6053, but the image's
inherited healthcheck still requested `http://localhost:6052/version`. Logs
showed the dashboard fully initialized and serving 6053 while every healthcheck
failed to connect to 6052. This was a healthcheck/configuration mismatch, not an
application failure.

Evidence:

- HostPanel active condition: `CONTAINER_UNHEALTHY` for `esphome`;
- Docker health log: repeated `curl: (7) Failed to connect to localhost port
  6052`;
- container command: `dashboard /config --port 6053`;
- host listener and direct request: 6053 listening, `/version` returned HTTP
  200 with ESPHome `2026.7.4`; 6052 had no listener;
- application logs showed `Device Builder ready` and successful compile/upload
  jobs.

Safe mutation performed: added an explicit service healthcheck to
`/opt/homeassistant/docker-compose.yml` targeting
`http://localhost:6053/version`, then recreated **only** `esphome` with
`docker compose up -d esphome`. Backup:
`/opt/homeassistant/docker-compose.yml.bak-esphome-healthcheck-20260820-145712`.

Final state: `esphome` became Docker `healthy`; Home Assistant remained the
same container and uptime (`Up 13 hours` at verification). HostPanel's normal
attention sync set the condition's `resolvedAt` to
`2026-08-20 11:59:32.470 UTC`.

